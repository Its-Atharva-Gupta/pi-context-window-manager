/**
 * Requirement 1 — Bash output interception.
 *
 * The `tool_result` event fires after bash execution finishes and *before*
 * the tool result message is created and sent to the LLM. Replacing
 * `content` here means the raw output never enters the session messages
 * array: the main agent only ever sees the digest.
 *
 * The raw output is discarded entirely — we also strip `fullOutputPath` /
 * `truncation` from details so nothing points back at the discarded bytes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, truncateTail } from "@earendil-works/pi-coding-agent";
import type { CtxConfig } from "./config";
import { runAuxModel } from "./model";
import { estimateTokensFromText, extractText, logEvent } from "./util";
import type { StatsApi } from "./stats";

/**
 * Strip the built-in bash tool's truncation note (which embeds the temp-file
 * path of the discarded raw output) before the text reaches the summarizer
 * or the fallback tail — the "discard entirely" guarantee includes not
 * pointing back at the raw bytes.
 */
function sanitizeOutput(text: string): string {
	return text
		.replace(/\[Output truncated:[^\]]*Full output saved to: \S+\]/g, "[output discarded]")
		.replace(/Full output saved to: \S+/g, "[output discarded]")
		.replace(/\[Output truncated:[^\]]*\]/g, "");
}

function buildSummaryPrompt(command: string, output: string, maxTokens: number): string {
	return [
		"You are an output summarizer for a coding agent's shell tool.",
		"Produce a concise factual digest of the command output below so the agent can continue its work without seeing the raw output.",
		"Preserve: exit codes and errors, file paths, numbers, versions, and any conclusions the output supports.",
		"Omit boilerplate, progress spam, and repetition. Use short bullet points.",
		`Target length: about ${Math.min(maxTokens * 4, 2000)} characters.`,
		"",
		`Command: ${command}`,
		"",
		"<output>",
		output,
		"</output>",
		"",
		"Digest:",
	].join("\n");
}

export function registerBashInterceptor(
	pi: ExtensionAPI,
	cfg: CtxConfig,
	stats: StatsApi,
): void {
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled || !cfg.bash) return;
		if (!isBashToolResult(event)) return;
		if (event.isError) return; // error output is kept verbatim (usually small, and details matter)

		const text = extractText(event.content);
		if (!text.trim()) return;
		const sanitized = sanitizeOutput(text);

		const command =
			typeof (event.input as { command?: unknown } | undefined)?.command === "string"
				? (event.input as { command: string }).command
				: "";
		const tokens = estimateTokensFromText(sanitized);
		if (tokens < cfg.bashMinTokens) return; // under threshold: pass through untouched

		const summary = await runAuxModel(ctx, cfg, buildSummaryPrompt(command, sanitized, cfg.bashMaxSummaryTokens), {
			maxTokens: cfg.bashMaxSummaryTokens,
			label: "bash-summarize",
			signal: ctx.signal,
		});

		// Never leak the temp path or truncation metadata of the discarded output.
		const details: Record<string, unknown> = { ...(event.details ?? {}) };
		delete details.fullOutputPath;
		delete details.truncation;

		if (summary) {
			const summaryTokens = estimateTokensFromText(summary);
			stats.recordBash(tokens, summaryTokens);
			logEvent({
				kind: "bash",
				toolCallId: event.toolCallId,
				command,
				originalTokens: tokens,
				summaryTokens,
				saved: tokens - summaryTokens,
			});
			return {
				content: [{ type: "text", text: summary }],
				details: { ...details, summarized: true, originalTokens: tokens, summaryTokens },
			};
		}

		// Degraded fallback: still keep the raw output out of context by showing a tail.
		const fallback = sanitizeOutput(truncateTail(sanitized, { maxLines: 120, maxBytes: cfg.bashFallbackBytes }).content);
		const note = `\n[context-window-manager: summarization unavailable; showing last ${cfg.bashFallbackBytes} bytes of output]`;
		const fallbackTokens = estimateTokensFromText(fallback + note);
		stats.recordBash(tokens, fallbackTokens);
		logEvent({
			kind: "bash-fallback",
			toolCallId: event.toolCallId,
			originalTokens: tokens,
			fallbackTokens,
			saved: tokens - fallbackTokens,
		});
		return {
			content: [{ type: "text", text: fallback + note }],
			details: { ...details, summarized: false, originalTokens: tokens, fallbackTokens },
		};
	});
}
