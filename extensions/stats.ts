/**
 * Requirement 5 — Token accounting.
 *
 * Tracks tokens saved per turn from each mechanism:
 *   - bash:    original output tokens − digest tokens (per intercepted result)
 *   - amnesia: `estimateTokens` of every message actually removed
 *   - lazy:    estimated tokens of tool specs + skill catalog *not* injected
 *              into this turn's context (avoided-injection estimate)
 *
 * Persisted as `ctxwm-stats` custom entries (survives reload / resume, never
 * sent to the LLM), surfaced in a live TUI widget, in `/ctx-stats`, and in a
 * JSONL event log.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CtxConfig } from "./config";
import { logEvent } from "./util";

export interface TurnStats {
	turn: number;
	bash: number;
	amnesia: number;
	lazy: number;
	write: number;
	total: number;
}

export interface StatsSnapshot {
	cumulative: { bash: number; amnesia: number; lazy: number; write: number; total: number };
	turns: TurnStats[];
}

export interface Cumulative {
	bash: number;
	amnesia: number;
	lazy: number;
	write: number;
	total: number;
}

export function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

export function widgetLine(c: Cumulative): string {
	return (
		`ctxwm saved ${fmtTokens(c.total)} tok ` +
		`(bash ${fmtTokens(c.bash)} · amnesia ${fmtTokens(c.amnesia)} · lazy ${fmtTokens(c.lazy)} · write ${fmtTokens(c.write)})`
	);
}

export type StatsApi = ReturnType<typeof createStats>;

export function createStats(pi: ExtensionAPI, cfg: CtxConfig) {
	const cumulative: Cumulative = { bash: 0, amnesia: 0, lazy: 0, write: 0, total: 0 };
	const turns: TurnStats[] = [];
	const current = { bash: 0, amnesia: 0, lazy: 0, write: 0 };
	// The lazy estimate is computed in before_agent_start (which fires before
	// the first turn_start), so it must survive beginTurn's reset and be
	// rolled into the turn total at endTurn.
	let pendingLazy = 0;
	let turnIndex = 0;

	function persist(): void {
		pi.appendEntry<StatsSnapshot>("ctxwm-stats", {
			cumulative: { ...cumulative },
			turns: turns.slice(-40),
		});
	}

	function updateWidget(ctx: ExtensionContext | undefined): void {
		if (!cfg.statsWidget || !ctx?.hasUI) return;
		try {
			ctx.ui.setWidget("ctxwm", [widgetLine(cumulative)]);
		} catch {
			/* widget is cosmetic */
		}
	}

	function beginTurn(index: number): void {
		turnIndex = index;
		current.bash = 0;
		current.amnesia = 0;
		current.lazy = 0;
		current.write = 0;
	}

	function endTurn(ctx: ExtensionContext | undefined): void {
		current.lazy = pendingLazy;
		pendingLazy = 0;
		const total = current.bash + current.amnesia + current.lazy + current.write;
		turns.push({ turn: turnIndex, bash: current.bash, amnesia: current.amnesia, lazy: current.lazy, write: current.write, total });
		cumulative.bash += current.bash;
		cumulative.amnesia += current.amnesia;
		cumulative.lazy += current.lazy;
		cumulative.write += current.write;
		cumulative.total += total;
		logEvent({
			kind: "turn",
			turn: turnIndex,
			bash: current.bash,
			amnesia: current.amnesia,
			lazy: current.lazy,
			write: current.write,
			total,
			cumulative: { ...cumulative },
		});
		persist();
		updateWidget(ctx);
	}

	function recordBash(originalTokens: number, resultTokens: number): void {
		current.bash += Math.max(0, originalTokens - resultTokens);
	}

	function recordAmnesia(tokens: number): void {
		current.amnesia += tokens;
	}

	function recordWrite(originalTokens: number, factTokens: number): void {
		current.write += Math.max(0, originalTokens - factTokens);
	}

	function setLazy(tokens: number): void {
		pendingLazy = Math.max(pendingLazy, tokens);
	}

	function restore(snapshot?: StatsSnapshot): void {
		if (!snapshot?.cumulative) return;
		cumulative.bash = snapshot.cumulative.bash ?? 0;
		cumulative.amnesia = snapshot.cumulative.amnesia ?? 0;
		cumulative.lazy = snapshot.cumulative.lazy ?? 0;
		cumulative.write = snapshot.cumulative.write ?? 0;
		cumulative.total = snapshot.cumulative.total ?? 0;
		turns.length = 0;
		turns.push(...(snapshot.turns ?? []));
	}

	return {
		beginTurn,
		endTurn,
		recordBash,
		recordAmnesia,
		recordWrite,
		setLazy,
		restore,
		getCumulative: (): Cumulative => ({ ...cumulative }),
		getTurns: (): TurnStats[] => [...turns],
	};
}
