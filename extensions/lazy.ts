/**
 * Requirement 3 — Lazy skill/tool loading.
 *
 * At startup the only capability the agent sees beyond pi's core tools is a
 * single meta-tool: `find_capability(description)`. It searches the full
 * tool catalog (`pi.getAllTools()`) and the skill catalog (pi's own skill
 * discovery) by description and injects the best match on demand:
 *
 *   - tools:  added to the active set → its spec appears in the system prompt
 *             and it becomes callable. Removed at the start of the *next*
 *             user message (task boundary) via `pi.setActiveTools`, restoring
 *             the base tool set.
 *   - skills: the SKILL.md content is returned as the tool result (the
 *             injection) and flagged for meta-amnesia pruning, so if the
 *             agent never uses it the content is dropped from context again.
 *
 * Skills are also stripped from the system prompt each turn (they are
 * re-added only via find_capability), which is what makes skill *loading*
 * lazy rather than listing the whole catalog at startup.
 */
import { readFileSync } from "node:fs";
import { getAgentDir, formatSkillsForPrompt, loadSkills, type ExtensionAPI, type Skill, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CtxConfig } from "./config";
import { estimateTokensFromText, logEvent } from "./util";
import type { StatsApi } from "./stats";
import type { AmnesiaApi } from "./amnesia";

interface Match {
	kind: "tool" | "skill";
	name: string;
	description: string;
	score: number;
	path?: string;
}

const TOOL_CATALOG_EXCLUDES = new Set(["find_capability"]);

function score(query: string, haystack: string): number {
	const q = query.toLowerCase();
	const h = haystack.toLowerCase();
	if (h.includes(q)) return 100 + Math.min(h.length, 1000) / 100; // exact substring: strong signal
	const qWords = q.split(/[^a-z0-9]+/).filter(Boolean);
	const hWords = new Set(h.split(/[^a-z0-9]+/).filter(Boolean));
	let s = 0;
	for (const w of qWords) {
		if (w.length < 2) continue;
		if (hWords.has(w)) s += 10;
		else if ([...hWords].some((hw) => hw.startsWith(w) || w.startsWith(hw))) s += 3;
	}
	return s;
}

function estimateToolSpecTokens(t: ToolInfo): number {
	const parts = [
		t.name,
		t.description ?? "",
		JSON.stringify(t.parameters ?? {}),
		...(t.promptGuidelines ?? []),
	];
	return estimateTokensFromText(parts.join(" "));
}

export function registerLazyLoading(
	pi: ExtensionAPI,
	cfg: CtxConfig,
	stats: StatsApi,
	amnesia: AmnesiaApi,
): void {
	let toolCatalog: ToolInfo[] = [];
	let skillCatalog: Skill[] = [];
	let baseTools: string[] = [];
	const lazilyActivated = new Set<string>();
	let catalogReady = false;

	function refreshCatalogs(ctx: ExtensionContext): void {
		try {
			toolCatalog = pi.getAllTools();
		} catch {
			/* catalog refresh is best-effort */
		}
		try {
			skillCatalog = loadSkills({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				skillPaths: [],
				includeDefaults: true,
			}).skills;
		} catch {
			/* skill discovery is best-effort */
		}
		if (!catalogReady) {
			catalogReady = true;
			baseTools = pi.getActiveTools().filter((t) => !TOOL_CATALOG_EXCLUDES.has(t));
		}
	}

	function search(query: string, kind: "any" | "tool" | "skill"): Match[] {
		const matches: Match[] = [];
		if (kind !== "skill") {
			for (const t of toolCatalog) {
				if (TOOL_CATALOG_EXCLUDES.has(t.name)) continue;
				const hay = `${t.name} ${t.description ?? ""} ${(t.promptGuidelines ?? []).join(" ")}`;
				const s = score(query, hay);
				if (s > 0) matches.push({ kind: "tool", name: t.name, description: t.description ?? "", score: s });
			}
		}
		if (kind !== "tool") {
			for (const sk of skillCatalog) {
				const s = score(query, `${sk.name} ${sk.description}`);
				if (s > 0) matches.push({ kind: "skill", name: sk.name, description: sk.description, score: s, path: sk.filePath });
			}
		}
		matches.sort((a, b) => b.score - a.score);
		return matches;
	}

	// ---- session start: build catalogs, restore base tool set ----
	pi.on("session_start", async (_event, ctx) => {
		refreshCatalogs(ctx);
	});

	// ---- task boundary: deactivate lazily loaded tools; strip skill specs ----
	pi.on("before_agent_start", async (event) => {
		if (!cfg.enabled) return;

		if (cfg.lazy && lazilyActivated.size > 0) {
			baseTools = pi.getActiveTools().filter((t) => !lazilyActivated.has(t) && !TOOL_CATALOG_EXCLUDES.has(t));
			lazilyActivated.clear();
			pi.setActiveTools([...baseTools, "find_capability"]);
		}

		if (cfg.lazy) {
			// Per-turn avoided-injection estimate: specs + skill catalog that
			// stayed out of this turn's context.
			const active = new Set(pi.getActiveTools());
			let avoided = 0;
			for (const t of toolCatalog) {
				if (TOOL_CATALOG_EXCLUDES.has(t.name) || active.has(t.name)) continue;
				avoided += estimateToolSpecTokens(t);
			}
			if (cfg.lazySkills) avoided += estimateTokensFromText(formatSkillsForPrompt(skillCatalog));
			stats.setLazy(avoided);
			logEvent({ kind: "lazy", avoidedTokens: avoided });
		}

		if (cfg.lazySkills) {
			const skills = event.systemPromptOptions.skills ?? [];
			if (skills.length > 0) {
				const section = formatSkillsForPrompt(skills);
				if (section && event.systemPrompt.includes(section)) {
					const stripped = event.systemPrompt
						.replace(section, "")
						.replace(/\n{3,}/g, "\n\n")
						.replace(/[ \t]+$/gm, "")
						.replace(/\s+$/, "");
					return { systemPrompt: stripped };
				}
			}
		}
		return undefined;
	});

	// ---- the one meta-tool ----
	pi.registerTool({
		name: "find_capability",
		label: "Find Capability",
		description:
			"Search the lazily-loaded tools and skills catalog by natural-language description and load the best match into context on demand. Only this meta-tool is preloaded; use it to discover and activate any other tool or skill instead of assuming one exists.",
		promptSnippet: "Search and lazily load tools and skills by description (find_capability)",
		promptGuidelines: [
			"Use find_capability when you need a tool or skill that is not already listed — call it with a concrete description of the capability and it will activate the best match for the current task.",
		],
		parameters: Type.Object({
			description: Type.String({
				description: "Describe the capability you need, e.g. 'search code for a regex across the repo' or 'summarize PDF documents'.",
			}),
			kind: Type.Optional(StringEnum(["any", "tool", "skill"] as const)),
			load: Type.Optional(Type.Boolean({ description: "Activate/inject the best match (default true)." })),
			top: Type.Optional(Type.Integer({ description: "Number of matches to return (default 3, max 8).", minimum: 1, maximum: 8 })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const query = String(params.description ?? "");
			const kind: "any" | "tool" | "skill" = params.kind ?? "any";
			const load = params.load ?? true;
			const top = Math.min(Math.max(params.top ?? 3, 1), 8);

			if (!catalogReady) refreshCatalogs(ctx);
			const matches = search(query, kind).slice(0, top);

			const lines: string[] = [];
			if (matches.length === 0) {
				lines.push(`No capability matched "${query}". Try rephrasing with concrete action verbs and nouns.`);
			} else {
				lines.push(`Matched capabilities for "${query}":`);
				for (const m of matches) lines.push(`- [${m.kind}] ${m.name}: ${m.description} (score ${m.score})`);
			}

			let loaded: { kind: "tool" | "skill"; name: string } | undefined;

			if (load && matches.length > 0) {
				const best = matches[0];
				if (best.kind === "tool") {
					const active = pi.getActiveTools();
					if (!active.includes(best.name)) {
						pi.setActiveTools([...active, best.name]);
						lazilyActivated.add(best.name);
						lines.push(`\nTool "${best.name}" activated for this task. It will be removed from context at the start of your next user message.`);
					} else {
						lines.push(`\nTool "${best.name}" is already active.`);
					}
					loaded = { kind: "tool", name: best.name };
				} else if (best.kind === "skill" && best.path) {
					let content: string;
					try {
						content = readFileSync(best.path, "utf8");
					} catch {
						lines.push(`\nSkill "${best.name}" matched but its file could not be read: ${best.path}`);
						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: { query, kind, matches, loaded: undefined, skillError: best.path },
						};
					}
					const cap = cfg.skillMaxChars;
					const body =
						content.length > cap
							? `${content.slice(0, cap)}\n…[skill content truncated at ${cap} chars; read ${best.path} for the full file]`
							: content;
					lines.push(`\nLoaded skill "${best.name}" (${best.path}). Its instructions follow.`);
					amnesia.flagSkillLoad(toolCallId, estimateTokensFromText(body));
					loaded = { kind: "skill", name: best.name };
					return {
						content: [{ type: "text", text: `${lines.join("\n")}\n\n${body}` }],
						details: { query, kind, matches, loaded, skillPath: best.path },
					};
				}
			}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { query, kind, matches, loaded },
		};
	},
	});
}
