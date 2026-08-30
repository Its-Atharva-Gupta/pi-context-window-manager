/**
 * context-window-manager
 *
 * Intelligent context window management for pi:
 *
 *   1. Bash output interception      — outputs > 2000 tokens are summarized
 *                                      out-of-band before they can enter
 *                                      context; the main agent only ever
 *                                      sees the digest.
 *   2. Meta-amnesia pruning          — read/grep/find/ls results are silently
 *                                      classified retain/drop by an out-of-band
 *                                      model call; DROP results are pruned
 *                                      from the tail of the messages array so
 *                                      the agent has no memory of the exchange.
 *   3. Lazy skill/tool loading       — only `find_capability` is preloaded;
 *                                      everything else is injected on demand
 *                                      and removed after the task.
 *   4. Write compression             — file content in write toolCall args is
 *                                      stripped at the tail and compressed
 *                                      into a persistent "what I've done" fact
 *                                      line (never pruned, survives /resume).
 *   5. Cache-safe architecture       — pruning touches only a contiguous tail
 *                                      suffix; the stable prefix (system prompt
 *                                      + early conversation) is never modified.
 *   6. Token accounting              — per-turn and cumulative savings tracked
 *                                      for each mechanism (widget, /ctx-stats,
 *                                      JSONL log, persisted snapshot).
 *
 * Place in ~/.pi/agent/extensions/context-window-manager/ (global) or
 * .pi/extensions/context-window-manager/ (project) and /reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { defaultLogPath, setLogPath } from "./util";
import { createStats, fmtTokens, widgetLine } from "./stats";
import { createAmnesia } from "./amnesia";
import { registerBashInterceptor } from "./bash";
import { registerLazyLoading } from "./lazy";
import { registerWriteCompressor } from "./write";

export default function contextWindowManager(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	if (!cfg.enabled) return;

	setLogPath(cfg.logFile ?? defaultLogPath());

	const stats = createStats(pi, cfg);
	const amnesia = createAmnesia(pi, cfg, stats);

	registerBashInterceptor(pi, cfg, stats);
	registerLazyLoading(pi, cfg, stats, amnesia);
	registerWriteCompressor(pi, cfg, stats);

	// ---- per-turn accounting ----
	pi.on("turn_start", async (event, _ctx) => {
		stats.beginTurn(event.turnIndex);
	});
	pi.on("turn_end", async (_event, ctx) => {
		stats.endTurn(ctx);
	});

	// ---- restore cumulative stats + widget across reloads / resumes ----
	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "ctxwm-stats") {
				stats.restore(entry.data as Parameters<typeof stats.restore>[0]);
			}
		}
		if (ctx.hasUI && cfg.statsWidget) {
			ctx.ui.setWidget("ctxwm", [widgetLine(stats.getCumulative())]);
		}
	});

	// ---- /ctx-stats command ----
	pi.registerCommand("ctx-stats", {
		description: "Show token savings from context-window management",
		handler: async (_args, ctx) => {
			const c = stats.getCumulative();
			const turns = stats.getTurns();
			const last = turns[turns.length - 1];
			const lines = [
				"Context window management — token savings:",
				`  cumulative: ${fmtTokens(c.total)} total (bash ${fmtTokens(c.bash)} · amnesia ${fmtTokens(c.amnesia)} · lazy ${fmtTokens(c.lazy)} · write ${fmtTokens(c.write)})`,
				last
					? `  last turn: ${fmtTokens(last.total)} (bash ${fmtTokens(last.bash)} · amnesia ${fmtTokens(last.amnesia)} · lazy ${fmtTokens(last.lazy)} · write ${fmtTokens(last.write)})`
					: "  last turn: —",
				`  turns tracked: ${turns.length}`,
				`  event log: ${cfg.logFile ?? defaultLogPath()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
