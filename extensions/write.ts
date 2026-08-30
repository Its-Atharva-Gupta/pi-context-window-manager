/**
 * Requirement 4 (new) — Write compression into persistent facts.
 *
 * The full file content of a `write` call lives in the assistant message's
 * toolCall arguments and stays in context for the rest of the session. This
 * module does two things:
 *
 *   1. Strips the `content` argument from write toolCalls at the tail —
 *      cache-safe: only the last assistant message is rewritten, so the
 *      stable prefix (system prompt + early conversation) is byte-identical
 *      and the KV cache on earlier turns is never invalidated.
 *   2. Compresses the file into a single persistent fact line, injected as a
 *      tiny custom message ("what I've done" working memory) that is never
 *      pruned and survives /resume:
 *        [Wrote src/model.py — CNN architecture, 3 conv layers, ~80 lines]
 *
 * Why the fact appends at the TAIL instead of a growing block at the top:
 * inserting into the prefix would shift every later token and invalidate the
 * whole KV cache on each new fact. Tail-append keeps the prefix identical;
 * each fact costs ~15 tokens and stays for the whole session.
 *
 * The fact generator is the same out-of-band aux model (active model, low
 * reasoning). If it fails, a heuristic fact (path + docstring/comment +
 * line count) is used so memory is never lost.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CtxConfig } from "./config";
import { runAuxModel } from "./model";
import { estimateTokensFromText, logEvent, shorten } from "./util";
import type { StatsApi } from "./stats";

export const FACT_CUSTOM_TYPE = "ctxwm-fact";

const countLines = (content: string): number => content.split("\n").length;

/** No-model fallback: path + first docstring/comment/signature + line count. */
function heuristicFact(path: string, content: string): string {
	const lines = countLines(content);
	const head = content.slice(0, 2000);
	let desc = "";

	const doc = head.match(/"""([\s\S]{0,160}?)"""/) ?? head.match(/'''([\s\S]{0,160}?)'''/);
	if (doc) desc = doc[1].split("\n")[0].trim();
	if (!desc) {
		const comment = head.match(/^#\s*(.{5,160})/m);
		if (comment) desc = comment[1].trim();
	}
	if (!desc) {
		const sig = head.match(/^\s*(?:class|def|const|export|function|async)\s+[A-Za-z0-9_]+[^\n]{0,80}/m);
		if (sig) desc = sig[0].trim();
	}

	return `[Wrote ${path}${desc ? ` — ${desc}` : ""}, ~${lines} lines]`;
}

function buildFactPrompt(path: string, content: string, lines: number): string {
	return [
		"You are a working-memory summarizer for a coding agent.",
		"The agent just wrote a file. Compress it into ONE line for a persistent 'what I've done' block.",
		"Use exactly this format: [Wrote <path> — <what the file is, its key components>, ~<N> lines]",
		"At most 25 words. No quotes, no markdown, no code fences, no extra text.",
		"",
		`Path: ${path}`,
		`Lines: ${lines}`,
		"",
		"<content>",
		content,
		"</content>",
		"",
		"Fact:",
	].join("\n");
}

function normalizeFact(raw: string, path: string, lines: number): string {
	let fact = raw
		.trim()
		.replace(/^```[a-z]*\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	if (!fact.startsWith("[Wrote")) {
		fact = `[Wrote ${path} — ${fact.replace(/^["'[\]\s]+|["'[\]\s]+$/g, "")}]`;
	}
	fact = fact.replace(/\s+/g, " ").trim();
	if (fact.length > 220) fact = `${fact.slice(0, 217)}...`;
	if (!fact.endsWith("]")) fact += "]";
	return fact;
}

async function generateFact(
	ctx: ExtensionContext,
	cfg: CtxConfig,
	path: string,
	content: string,
	lines: number,
): Promise<string> {
	const out = await runAuxModel(
		ctx,
		cfg,
		buildFactPrompt(path, shorten(content, cfg.writeMaxContentChars), lines),
		{ maxTokens: cfg.writeFactMaxTokens, label: "write-fact", signal: ctx.signal },
	);
	if (out) {
		const fact = normalizeFact(out, path, lines);
		if (fact.length > 8) return fact;
	}
	return heuristicFact(path, content); // fail-safe: memory is never lost
}

export function registerWriteCompressor(
	pi: ExtensionAPI,
	cfg: CtxConfig,
	stats: StatsApi,
): void {
	/** toolCallIds of writes that were compressed (args eligible for stripping). */
	const stripCandidates = new Set<string>();

	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled || !cfg.write) return;
		if (event.toolName !== "write" || event.isError) return;

		const input = event.input as { path?: unknown; content?: unknown } | undefined;
		const path = typeof input?.path === "string" ? input.path : "";
		const content = typeof input?.content === "string" ? input.content : "";
		if (!path || !content) return;
		if (content.length < cfg.writeMinBytes) return; // small writes pass through

		const lines = countLines(content);
		const originalTokens = estimateTokensFromText(content);

		const fact = await generateFact(ctx, cfg, path, content, lines);

		try {
			pi.sendMessage(
				{ customType: FACT_CUSTOM_TYPE, content: fact, display: true, details: { path } },
				{ deliverAs: "steer" },
			);
		} catch {
			logEvent({ kind: "write-inject-failed", toolCallId: event.toolCallId, path });
		}

		stripCandidates.add(event.toolCallId);
		const factTokens = estimateTokensFromText(fact);
		stats.recordWrite(originalTokens, factTokens);
		logEvent({
			kind: "write",
			toolCallId: event.toolCallId,
			path,
			originalTokens,
			factTokens,
			saved: originalTokens - factTokens,
			fact,
		});
	});

	// Strip the file content from write toolCall arguments at the tail.
	pi.on("context", async (event) => {
		if (stripCandidates.size === 0) return;
		const messages = event.messages;

		// Only the LAST assistant message is rewritten (cache-safe boundary).
		let idx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as { role?: string }).role === "assistant") {
				idx = i;
				break;
			}
		}
		if (idx < 0) return;

		const assistant = messages[idx] as { content?: unknown };
		const blocks = Array.isArray(assistant.content) ? assistant.content : [];
		let changed = false;
		const newBlocks = blocks.map((b) => {
			const block = b as { type?: unknown; name?: unknown; id?: unknown; arguments?: Record<string, unknown> };
			if (
				block?.type === "toolCall" &&
				block.name === "write" &&
				typeof block.id === "string" &&
				stripCandidates.has(block.id) &&
				block.arguments &&
				typeof block.arguments === "object" &&
				"content" in block.arguments
			) {
				changed = true;
				const { content: _content, ...rest } = block.arguments;
				return { ...block, arguments: rest };
			}
			return b;
		});
		if (!changed) return;
		assistant.content = newBlocks;
		return { messages };
	});

	// Expire candidates at task boundaries (like amnesia).
	pi.on("agent_end", async () => stripCandidates.clear());
	pi.on("before_agent_start", async () => stripCandidates.clear());
}
