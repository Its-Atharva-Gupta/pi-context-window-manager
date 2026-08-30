/**
 * Requirement 2 — Meta-amnesia pruning.
 *
 * After read/grep/find/ls (and skill loads via find_capability) complete, the
 * extension runs a *silent* retain/drop classification on a separate,
 * out-of-band model call. That question/answer exchange never enters the
 * messages array at all — so there is nothing to scrub and the main agent
 * never knows it was asked.
 *
 * If the result is tagged DROP, it is removed from the LLM's view via the
 * `context` event (fired before each LLM call).
 *
 * Requirement 4 — cache safety. Removal is strictly tail-only:
 *   - only a *contiguous suffix* of the messages array is ever dropped
 *     (trailing tool results + the tool-call-only assistant messages that
 *     produced them),
 *   - tool-call blocks for dropped results are stripped from the single
 *     boundary assistant message (the last kept message) when it has text,
 *   - everything before that boundary — the stable prefix (system prompt +
 *     early conversation) — is byte-identical to previous requests, so the
 *     KV prompt cache on earlier turns is never invalidated.
 * If a dropped result ended up mid-array (a later message already built on
 * it), it is simply retained: we never rewrite history.
 *
 * Accounting: each actually-removed message is counted with pi's
 * `estimateTokens` so reported savings match the real context cost.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CtxConfig } from "./config";
import { runAuxModel } from "./model";
import { estimateTokensFromText, extractText, logEvent, shorten } from "./util";
import type { StatsApi } from "./stats";

/** Tools whose results are eligible for retain/drop classification. */
const TAG_TOOLS = new Set(["read", "grep", "find", "ls", "find_capability"]);

interface DropCandidate {
	tokens: number;
}

/* ---- structural helpers over context-event messages ---- */

type AnyMessage = { role?: string; content?: unknown; toolCallId?: string };

const isAssistant = (m: unknown): m is AnyMessage & { role: "assistant" } =>
	typeof m === "object" && m !== null && (m as AnyMessage).role === "assistant";

const isToolResult = (m: unknown): m is AnyMessage & { role: "toolResult" } =>
	typeof m === "object" && m !== null && (m as AnyMessage).role === "toolResult";

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

const contentBlocks = (m: AnyMessage): unknown[] =>
	(Array.isArray(m.content) ? m.content : []);

const isToolCallBlock = (b: unknown): b is ToolCallBlock =>
	typeof b === "object" &&
	b !== null &&
	(b as { type?: unknown }).type === "toolCall" &&
	typeof (b as { id?: unknown }).id === "string";

const toolCalls = (m: AnyMessage): ToolCallBlock[] => contentBlocks(m).filter(isToolCallBlock);

const hasTextBlock = (m: AnyMessage): boolean =>
	contentBlocks(m).some(
		(b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
	);

const estimateMessageTokens = (m: unknown): number => {
	try {
		return estimateTokens(m as Parameters<typeof estimateTokens>[0]);
	} catch {
		return estimateTokensFromText(extractText((m as AnyMessage)?.content));
	}
};

/* ---- classifier ---- */

async function classify(
	ctx: ExtensionContext,
	cfg: CtxConfig,
	toolName: string,
	text: string,
): Promise<"RETAIN" | "DROP"> {
	const prompt = [
		"You are a context-management classifier for a coding agent.",
		"Decide whether the following tool result must stay in the agent's working memory (RETAIN) or can be removed (DROP).",
		"",
		"DROP only when ALL of these hold:",
		"- The content is raw retrieval (file contents, search results, listings) that can be re-fetched at any time with the same tool.",
		"- The agent's reasoning so far does not depend on this exact content (no decisions were based on it).",
		"- Removing it would not make the agent's later responses incoherent.",
		"",
		"RETAIN when the content was used for decisions, error analysis, or anything the agent must remember.",
		"",
		`Tool: ${toolName}`,
		"",
		"<result>",
		shorten(text, cfg.amnesiaMaxInputChars),
		"</result>",
		"",
		'Reply with exactly one JSON object: {"decision": "RETAIN"} or {"decision": "DROP"}',
	].join("\n");

	const out = await runAuxModel(ctx, cfg, prompt, {
		maxTokens: cfg.tagMaxTokens,
		label: "amnesia-tag",
		signal: ctx.signal,
	});
	if (!out) return "RETAIN"; // fail-safe: never drop when the tagger is unavailable

	try {
		const cleaned = out
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/```\s*$/, "")
			.trim();
		const parsed = JSON.parse(cleaned) as { decision?: unknown };
		return parsed?.decision === "DROP" ? "DROP" : "RETAIN";
	} catch {
		return /DROP/i.test(out) ? "DROP" : "RETAIN";
	}
}

export interface AmnesiaApi {
	/** Mark a find_capability skill-load result as a drop candidate (no extra tag call). */
	flagSkillLoad(toolCallId: string, tokens: number): void;
}

export function createAmnesia(
	pi: ExtensionAPI,
	cfg: CtxConfig,
	stats: StatsApi,
): AmnesiaApi {
	const candidates = new Map<string, DropCandidate>();

	function flagSkillLoad(toolCallId: string, tokens: number): void {
		if (!cfg.enabled || !cfg.amnesia) return;
		candidates.set(toolCallId, { tokens });
	}

	// 1) Silently tag each eligible tool result, out-of-band.
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled || !cfg.amnesia) return;
		if (!TAG_TOOLS.has(event.toolName)) return;
		if (event.isError) return;
		const text = extractText(event.content);
		if (!text.trim()) return;
		const tokens = estimateTokensFromText(text);
		if (tokens < cfg.amnesiaMinTokens) return;
		if (candidates.has(event.toolCallId)) return; // already flagged by find_capability

		const decision = await classify(ctx, cfg, event.toolName, text);
		logEvent({
			kind: "amnesia-tag",
			toolCallId: event.toolCallId,
			tool: event.toolName,
			decision,
			tokens,
		});
		if (decision === "DROP") {
			candidates.set(event.toolCallId, { tokens });
		}
	});

	// 2) Apply tail-only pruning before each LLM call.
	pi.on("context", async (event) => {
		if (candidates.size === 0) return;
		const dropSet = new Set(candidates.keys());

		let messages = event.messages;
		const removed = new Set<number>();
		const droppedResultIds = new Set<string>();

		// Walk from the end collecting the maximal droppable contiguous suffix:
		// trailing toolResults tagged DROP, plus tool-call-only assistant
		// messages whose every call was dropped. Stop at the first message that
		// must be kept — never remove anything before it.
		let i = messages.length - 1;
		while (i >= 0) {
			const m = messages[i];
			if (isToolResult(m)) {
				if (dropSet.has(m.toolCallId)) {
					removed.add(i);
					droppedResultIds.add(m.toolCallId);
					i--;
					continue;
				}
				break;
			}
			if (isAssistant(m)) {
				const calls = toolCalls(m);
				if (calls.length > 0 && !hasTextBlock(m) && calls.every((c) => dropSet.has(c.id))) {
					removed.add(i);
					i--;
					continue;
				}
				break;
			}
			break;
		}

		if (removed.size === 0) return;

		// Strip the tool-call blocks for dropped results from the assistant
		// message that *owns* them — the last assistant before the removed
		// suffix, scanning back past kept results of the same round (parallel
		// tool calls emit results in source order, so a kept result may sit
		// between the owning assistant and the removed tail). This keeps the
		// conversation well-formed. event.messages is a deep copy, so
		// in-place mutation is safe and the stable prefix stays untouched.
		const firstRemoved = Math.min(...removed);
		let boundaryIndex = firstRemoved - 1;
		while (boundaryIndex >= 0 && isToolResult(messages[boundaryIndex])) {
			boundaryIndex--; // kept result of the same round: keep looking for the owner
		}
		if (boundaryIndex >= 0) {
			const boundary = messages[boundaryIndex];
			if (isAssistant(boundary)) {
				const calls = toolCalls(boundary);
				const toStrip = calls.filter((c) => droppedResultIds.has(c.id));
				if (toStrip.length > 0) {
					const keptCalls = calls.filter((c) => !droppedResultIds.has(c.id));
					const otherBlocks = contentBlocks(boundary).filter((b) => !isToolCallBlock(b));
					const newContent = [...otherBlocks, ...keptCalls];
					(boundary as { content?: unknown }).content = newContent;
					if (newContent.length === 0) removed.add(boundaryIndex);
				}
			}
		}

		if (removed.size === 0) return;

		let saved = 0;
		for (const idx of removed) saved += estimateMessageTokens(messages[idx]);
		stats.recordAmnesia(saved);
		logEvent({
			kind: "amnesia-remove",
			saved,
			messageCount: removed.size,
			droppedResultIds: [...droppedResultIds],
		});
		for (const id of droppedResultIds) candidates.delete(id);

		return { messages: messages.filter((_, idx) => !removed.has(idx)) };
	});

	// Expire any candidates that were never applied (e.g. the result ended up
	// mid-array, or the turn ended before the next LLM call). Meta-amnesia
	// never rewrites history, so expired candidates become permanent.
	pi.on("agent_end", async () => candidates.clear());
	pi.on("before_agent_start", async () => candidates.clear());

	return { flagSkillLoad };
}
