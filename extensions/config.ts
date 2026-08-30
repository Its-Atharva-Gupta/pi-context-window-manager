/**
 * Configuration for the context-window-manager extension.
 *
 * All knobs are environment variables so the extension works with zero
 * setup and can be tuned per-project or per-machine without code changes.
 */

export interface CtxConfig {
	/** Master switch. PI_CTX_OFF=1 disables the whole extension. */
	enabled: boolean;

	/* ---- 1. Bash output interception ---- */
	bash: boolean;
	/** Summarize bash output when it exceeds this many tokens (default 2000). */
	bashMinTokens: number;
	/** Output cap for the summarizer digest. */
	bashMaxSummaryTokens: number;
	/** Fallback tail size (bytes) shown when the summarizer is unavailable. */
	bashFallbackBytes: number;

	/* ---- 2. Meta-amnesia pruning ---- */
	amnesia: boolean;
	/**
	 * Only run the (out-of-band) retain/drop tagger on results at least this
	 * large. 0 = tag every read/grep/find/ls result. Default 250 tokens so
	 * trivial results are never tagged (each tag is a model round trip).
	 */
	amnesiaMinTokens: number;
	/** How much of a result the tagger actually sees. */
	amnesiaMaxInputChars: number;
	/** Max output tokens for the tagger (it only returns RETAIN/DROP). */
	tagMaxTokens: number;

	/* ---- 3. Lazy skill/tool loading ---- */
	lazy: boolean;
	lazySkills: boolean;
	/** Cap on how much SKILL.md content is injected into context. */
	skillMaxChars: number;

	/* ---- Aux model (shared by summarizer + tagger) ---- */
	/**
	 * Override the aux model as "provider/id". Default: reuse the user's
	 * active model with low reasoning effort (cheap/fast pass).
	 */
	auxModel: string | undefined;
	/** Timeout for aux model calls. */
	auxTimeoutMs: number;

	/* ---- 5. Token accounting ---- */
	statsWidget: boolean;
	/** JSONL event log path; default ~/.pi/agent/logs/ctxwm.jsonl */
	logFile: string | undefined;
}

const bool = (v: string | undefined, dflt: boolean): boolean =>
	v === undefined ? dflt : v === "1" || v.toLowerCase() === "true";

const num = (v: string | undefined, dflt: number): number => {
	if (v === undefined) return dflt;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function loadConfig(): CtxConfig {
	return {
		enabled: !bool(process.env.PI_CTX_OFF, false),
		bash: bool(process.env.PI_CTX_BASH, true),
		bashMinTokens: num(process.env.PI_CTX_BASH_MIN_TOKENS, 2000),
		bashMaxSummaryTokens: num(process.env.PI_CTX_BASH_MAX_SUMMARY_TOKENS, 1024),
		bashFallbackBytes: num(process.env.PI_CTX_BASH_FALLBACK_BYTES, 3000),
		amnesia: bool(process.env.PI_CTX_AMNESIA, true),
		amnesiaMinTokens: num(process.env.PI_CTX_AMNESIA_MIN_TOKENS, 250),
		amnesiaMaxInputChars: num(process.env.PI_CTX_AMNESIA_MAX_CHARS, 6000),
		tagMaxTokens: num(process.env.PI_CTX_TAG_MAX_TOKENS, 24),
		lazy: bool(process.env.PI_CTX_LAZY, true),
		lazySkills: bool(process.env.PI_CTX_LAZY_SKILLS, true),
		skillMaxChars: num(process.env.PI_CTX_SKILL_MAX_CHARS, 8000),
		auxModel: process.env.PI_CTX_AUX_MODEL || undefined,
		auxTimeoutMs: num(process.env.PI_CTX_AUX_TIMEOUT_MS, 20000),
		statsWidget: bool(process.env.PI_CTX_STATS_WIDGET, true),
		logFile: process.env.PI_CTX_LOG_FILE || undefined,
	};
}
