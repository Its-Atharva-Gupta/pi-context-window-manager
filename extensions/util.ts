/**
 * Small shared helpers: text extraction, token estimation, abort-aware
 * timeouts, and the JSONL event log used for token accounting.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Same heuristic as pi's `estimateTokens(message)` (chars/4, conservative /
 * over-estimating) but for a raw string. Keeps accounting consistent between
 * raw text and real AgentMessage objects.
 */
export const estimateTokensFromText = (text: string): number =>
	Math.max(0, Math.ceil(text.length / 4));

/** Extract concatenated text from a message content array (or a string). */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

export function shorten(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/**
 * Run `fn` with a composite AbortSignal (outer ctx.signal + own timeout).
 * Rejects on abort/timeout so callers can degrade gracefully.
 */
export function withTimeout<T>(
	signal: AbortSignal | undefined,
	ms: number,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`context-window-manager: timed out after ${ms}ms`)),
		ms,
	);
	const onOuterAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) {
			clearTimeout(timer);
			return Promise.reject(new Error("context-window-manager: aborted"));
		}
		signal.addEventListener("abort", onOuterAbort, { once: true });
	}
	const cleanup = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onOuterAbort);
	};
	return fn(controller.signal).then(
		(v) => {
			cleanup();
			return v;
		},
		(e) => {
			cleanup();
			throw e;
		},
	);
}

let logPath: string | undefined;

export function setLogPath(p: string | undefined): void {
	logPath = p;
}

export function defaultLogPath(): string {
	return join(getAgentDir(), "logs", "ctxwm.jsonl");
}

/** Append one JSON line to the event log (best effort, never throws). */
export function logEvent(entry: Record<string, unknown>): void {
	if (!logPath) return;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		/* logging is best-effort */
	}
}
