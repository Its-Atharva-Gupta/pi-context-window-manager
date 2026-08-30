/**
 * Smoke tests for pi-context-window-manager.
 *
 * Loads the real extension modules through jiti (the same loader pi uses),
 * resolves pi packages from this repo's node_modules, and exercises:
 *   - config/env parsing
 *   - token estimation + text extraction helpers
 *   - the meta-amnesia tail-pruning algorithm (cache-safety cases)
 *   - lazy tool activation / deactivation lifecycle
 *   - bash interception fallback path
 *   - token accounting rollup (lazy survives beginTurn regression)
 *   - pi's own package manifest discovery (pi.extensions resolution)
 *
 * Run: npm test   (requires `npm install` first)
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);

const repoDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const { loadConfig } = jiti(`${repoDir}/extensions/config.ts`);
const { estimateTokensFromText, extractText, withTimeout } = jiti(`${repoDir}/extensions/util.ts`);
const { createAmnesia } = jiti(`${repoDir}/extensions/amnesia.ts`);
const { registerBashInterceptor } = jiti(`${repoDir}/extensions/bash.ts`);
const { registerLazyLoading } = jiti(`${repoDir}/extensions/lazy.ts`);
const { createStats } = jiti(`${repoDir}/extensions/stats.ts`);
const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");

let failures = 0;
const ok = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name} ${extra}`);
	}
};

// ---------- config ----------
console.log("config:");
{
	const cfg = loadConfig();
	ok("defaults sane", cfg.enabled && cfg.bashMinTokens === 2000 && cfg.amnesiaMinTokens === 250 && cfg.lazy && cfg.lazySkills);
	ok("env override", (() => {
		process.env.PI_CTX_BASH_MIN_TOKENS = "42";
		process.env.PI_CTX_OFF = "1";
		const c2 = loadConfig();
		delete process.env.PI_CTX_BASH_MIN_TOKENS;
		delete process.env.PI_CTX_OFF;
		return c2.bashMinTokens === 42 && c2.enabled === false;
	})());
}

// ---------- util ----------
console.log("util:");
ok("estimateTokensFromText 4 chars/token", estimateTokensFromText("abcd") === 1 && estimateTokensFromText("a") === 1);
ok("extractText joins text blocks", extractText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]) === "a\nb");
ok("extractText handles string", extractText("raw") === "raw");
ok("withTimeout rejects on timeout", (async () => {
	try {
		await withTimeout(undefined, 30, () => new Promise(() => {}));
		return false;
	} catch { return true; }
})());
ok("withTimeout resolves value", (async () => (await withTimeout(undefined, 1000, async () => 7)) === 7)());

// ---------- amnesia ----------
console.log("amnesia:");
const assistant = (content) => ({ role: "assistant", content, provider: "x", model: "m", usage: {}, stopReason: "stop", timestamp: 1 });
const text = (s) => [{ type: "text", text: s }];
const toolCall = (id, name = "read") => ({ type: "toolCall", id, name, arguments: { path: "f" } });
const toolResult = (id, s) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: text(s), isError: false, timestamp: 2 });

function makeHarness() {
	const handlers = {};
	const pi = {
		on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => ["read", "bash", "find_capability"],
		getAllTools: () => [],
		setActiveTools: () => {},
	};
	let amnesiaSaved = 0;
	const stats = {
		recordAmnesia: (n) => { amnesiaSaved += n; },
		recordBash: () => {},
		setLazy: () => {},
	};
	const cfg = loadConfig();
	cfg.auxModel = undefined;
	const amnesia = createAmnesia(pi, cfg, stats);
	const ctx = async (messages) => {
		const handler = handlers["context"][0];
		const res = await handler({ messages: structuredClone(messages) }, {});
		return res?.messages ?? messages;
	};
	return { amnesia, stats, ctx, getSaved: () => amnesiaSaved };
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c1", 100);
	const out = await h.ctx([assistant([...text("let me check the config"), toolCall("c1")]), toolResult("c1", "config: enabled")]);
	ok("case1: result removed", out.length === 1 && out[0].content.length === 1);
	ok("case1: toolCall stripped from boundary", out[0].content[0].type === "text");
	ok("case1: stats recorded", h.getSaved() > 0);
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c2", 100);
	const out = await h.ctx([assistant([toolCall("c2")]), toolResult("c2", "blob")]);
	ok("case2: whole round removed", out.length === 0);
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c3", 100);
	const out = await h.ctx([
		assistant([...text("first"), toolCall("c3")]),
		toolResult("c3", "blob"),
		assistant(text("done")),
	]);
	ok("case3: mid-array never pruned", out.length === 3);
	ok("case3: no stats", h.getSaved() === 0);
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c4a", 100);
	const out = await h.ctx([
		assistant([toolCall("c4a"), toolCall("c4b")]),
		toolResult("c4a", "droppable blob"),
		toolResult("c4b", "kept blob"),
	]);
	ok("case4: mixed round retained", out.length === 3);
	ok("case4: no stats", h.getSaved() === 0);
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c5a", 100);
	h.amnesia.flagSkillLoad("c5b", 100);
	const out = await h.ctx([
		assistant([toolCall("c5a")]),
		toolResult("c5a", "blob a"),
		assistant([toolCall("c5b")]),
		toolResult("c5b", "blob b"),
	]);
	ok("case5: multi-round tail pruned", out.length === 0);
	ok("case5: stats recorded", h.getSaved() > 0);
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c6a", 100);
	const out = await h.ctx([
		assistant([...text("reading both"), toolCall("c6a"), toolCall("c6b")]),
		toolResult("c6a", "droppable"),
		toolResult("c6b", "kept"),
	]);
	ok("case6: suffix ends at kept result", out.length === 3 && h.getSaved() === 0);
}

{
	const h = makeHarness();
	h.amnesia.flagSkillLoad("c7a", 100);
	const out = await h.ctx([
		assistant([...text("reading both"), toolCall("c7a"), toolCall("c7b")]),
		toolResult("c7b", "kept"),
		toolResult("c7a", "droppable"),
	]);
	ok("case7: dropped trailing result removed", out.length === 2);
	ok("case7: boundary keeps text + kept call, strips dropped call", out[0].content.length === 2 && out[0].content[0].type === "text" && out[0].content[1].id === "c7b");
	ok("case7: stats recorded", h.getSaved() > 0);
}

// ---------- bash interceptor (fallback path when no aux model) ----------
console.log("bash:");
{
	const handlers = {};
	let bashSaved = 0;
	const pi = {
		on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	};
	const cfg = loadConfig();
	cfg.bashMinTokens = 10;
	cfg.bashFallbackBytes = 200;
	registerBashInterceptor(pi, cfg, {
		recordBash: (orig, res) => { bashSaved += orig - res; },
		recordAmnesia: () => {},
		setLazy: () => {},
	});
	const handler = handlers["tool_result"][0];
	const raw = "line\n".repeat(100);
	const res = await handler(
		{
			toolCallId: "b1",
			toolName: "bash",
			input: { command: "echo hi" },
			content: [{ type: "text", text: raw }],
			details: { command: "echo hi", fullOutputPath: "/tmp/raw.log" },
			isError: false,
		},
		{ model: undefined, modelRegistry: {}, signal: undefined, hasUI: false },
	);
	ok("bash: fallback content is truncated, not raw", res && res.content[0].text.length < raw.length);
	ok("bash: fullOutputPath stripped from details", res && res.details.fullOutputPath === undefined);
	ok("bash: temp path leaked into digest is sanitized", (() => {
		// simulate built-in truncation note embedded in content
		const withNote = raw + "\n\n[Output truncated: 100 of 6000 lines (1KB of 38KB). Full output saved to: /tmp/pi-bash-abc.log]";
		return new Promise((resolve) => {
			handler(
				{ toolCallId: "b2", toolName: "bash", input: { command: "x" }, content: [{ type: "text", text: withNote }], details: {}, isError: false },
				{ model: undefined, modelRegistry: {}, signal: undefined },
			).then((r) => resolve(!JSON.stringify(r.content[0].text).includes("/tmp/pi-bash-abc.log")));
		});
	})());
	ok("bash: savings recorded", bashSaved > 0);
	const small = await handler(
		{ toolCallId: "b3", toolName: "bash", input: { command: "x" }, content: [{ type: "text", text: "ok" }], details: {}, isError: false },
		{ model: undefined, modelRegistry: {}, signal: undefined },
	);
	ok("bash: small output passes through", small === undefined);
}

// ---------- lazy search / activation lifecycle ----------
console.log("lazy:");
{
	const handlers = {};
	let activeTools = ["read", "bash", "find_capability"];
	const pi = {
		on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
		registerTool: (def) => { pi._tool = def; },
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => [...activeTools],
		getAllTools: () => [
			{ name: "edit", description: "Edit a single file using exact text replacement", parameters: {}, promptGuidelines: [] },
			{ name: "grep", description: "Search file contents with regex", parameters: {}, promptGuidelines: [] },
		],
		setActiveTools: (names) => { activeTools = names; },
	};
	const cfg = loadConfig();
	registerLazyLoading(pi, cfg, { setLazy: () => {}, recordAmnesia: () => {}, recordBash: () => {} }, { flagSkillLoad: () => {} });
	await handlers["session_start"][0]({}, { cwd: repoDir, hasUI: false });

	const res = await pi._tool.execute("t1", { description: "edit a file with exact replacement", load: true, kind: "tool", top: 3 }, undefined, undefined, {});
	ok("lazy: matched edit tool", JSON.stringify(res.content[0].text).includes("edit"));
	ok("lazy: activated edit", activeTools.includes("edit"));
	ok("lazy: find_capability stays active", activeTools.includes("find_capability"));

	await handlers["before_agent_start"][0]({ systemPrompt: "sys", systemPromptOptions: { skills: [] } }, {});
	ok("lazy: deactivated at next user turn", !activeTools.includes("edit"));
	ok("lazy: base restored", activeTools.includes("read") && activeTools.includes("bash"));
}

// ---------- stats: lazy survives beginTurn (regression for lazy=0 bug) ----------
console.log("stats:");
{
	const entries = [];
	const pi = { appendEntry: (t, d) => entries.push({ t, d }) };
	const cfg = loadConfig();
	const stats = createStats(pi, cfg);
	stats.setLazy(877);
	stats.beginTurn(0);
	stats.recordBash(5000, 300);
	stats.endTurn(undefined);
	const c = stats.getCumulative();
	ok("stats: lazy rolled into turn despite beginTurn", c.lazy === 877);
	ok("stats: bash rolled in", c.bash === 4700);
	ok("stats: total sums", c.total === 877 + 4700);
	const lastTurn = stats.getTurns()[0];
	ok("stats: turn entry carries lazy", lastTurn.lazy === 877 && lastTurn.bash === 4700);
	stats.beginTurn(1);
	stats.endTurn(undefined);
	ok("stats: pendingLazy consumed after endTurn", stats.getCumulative().lazy === 877);
	ok("stats: persisted snapshot entries", entries.length >= 2 && entries[0].t === "ctxwm-stats");
}

// ---------- write compression (facts) ----------
console.log("write:");
{
	const handlers = {};
	let sentFact = null;
	let writeSaved = 0;
	const pi = {
		on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		sendMessage: (msg, opts) => { sentFact = { msg, opts }; },
	};
	const cfg = loadConfig();
	cfg.writeMinBytes = 100; // make small writes eligible for the test
	const { registerWriteCompressor } = jiti(`${repoDir}/extensions/write.ts`);
	registerWriteCompressor(pi, cfg, {
		recordWrite: (orig, fact) => { writeSaved += orig - fact; },
		recordBash: () => {}, recordAmnesia: () => {}, setLazy: () => {},
	});
	const tagHandler = handlers["tool_result"][0];
	const ctxHandler = handlers["context"][0];

	const content = '\"\"\"CNN model\"\"\"\nimport torch\nclass CNN(torch.nn.Module):\n    pass\n'.repeat(40);
	const res = await tagHandler(
		{ toolCallId: "w1", toolName: "write", input: { path: "src/model.py", content }, details: undefined, isError: false },
		{ model: undefined, modelRegistry: {}, signal: undefined }, // no aux model -> heuristic fact
	);
	ok("write: fact injected via sendMessage (steer)", sentFact !== null && sentFact.opts.deliverAs === "steer");
	ok("write: fact is a single [Wrote ...] line", sentFact && /^\[Wrote src\/model\.py — .+~\d+ lines\]$/.test(sentFact.msg.content));
	ok("write: savings recorded", writeSaved > 0);

	// context: content stripped from the last assistant message's write args
	const out = await ctxHandler({
		messages: [
			assistant([...text("writing model"), { type: "toolCall", id: "w1", name: "write", arguments: { path: "src/model.py", content } }]),
			{ role: "toolResult", toolCallId: "w1", toolName: "write", content: text("Successfully wrote 10 bytes"), isError: false, timestamp: 2 },
		],
	}, {});
	const writeCall = out.messages[0].content.find((b) => b.type === "toolCall" && b.name === "write");
	ok("write: content stripped from args, path kept", writeCall && writeCall.arguments.content === undefined && writeCall.arguments.path === "src/model.py");
	ok("write: boundary text preserved", out.messages[0].content.some((b) => b.type === "text"));

	// small write below threshold: untouched, no fact
	sentFact = null;
	const small = await tagHandler(
		{ toolCallId: "w2", toolName: "write", input: { path: "x.txt", content: "tiny" }, details: undefined, isError: false },
		{ model: undefined, modelRegistry: {}, signal: undefined },
	);
	ok("write: small write passes through (no fact, no strip)", sentFact === null);
	const smallOut = await ctxHandler({
		messages: [
			assistant([{ type: "toolCall", id: "w2", name: "write", arguments: { path: "x.txt", content: "tiny" } }]),
			{ role: "toolResult", toolCallId: "w2", toolName: "write", content: text("ok"), isError: false, timestamp: 2 },
		],
	}, {});
	const out2 = smallOut ?? { messages: [
		assistant([{ type: "toolCall", id: "w2", name: "write", arguments: { path: "x.txt", content: "tiny" } }]),
		{ role: "toolResult", toolCallId: "w2", toolName: "write", content: text("ok"), isError: false, timestamp: 2 },
	] };
	ok("write: small write args intact", out2.messages[0].content[0].arguments.content === "tiny");

	// cache-safety: write args in a NON-last assistant message are never stripped
	sentFact = null;
	const w3 = await tagHandler(
		{ toolCallId: "w3", toolName: "write", input: { path: "b.ts", content: "x".repeat(500) }, details: undefined, isError: false },
		{ model: undefined, modelRegistry: {}, signal: undefined },
	);
	const out3raw = await ctxHandler({
		messages: [
			assistant([{ type: "toolCall", id: "w3", name: "write", arguments: { path: "b.ts", content: "x".repeat(500) } }]),
			{ role: "toolResult", toolCallId: "w3", toolName: "write", content: text("ok"), isError: false, timestamp: 2 },
			assistant(text("next step")), // later message -> write call is now mid-array
		],
	}, {});
	const out3 = out3raw ?? { messages: [
		assistant([{ type: "toolCall", id: "w3", name: "write", arguments: { path: "b.ts", content: "x".repeat(500) } }]),
		{ role: "toolResult", toolCallId: "w3", toolName: "write", content: text("ok"), isError: false, timestamp: 2 },
		assistant(text("next step")),
	] };
	ok("write: mid-array write args never stripped (cache safety)", out3.messages[0].content[0].arguments.content === "x".repeat(500));
}

// ---------- pi package manifest resolution ----------
console.log("package manifest:");
{
	const result = await discoverAndLoadExtensions([repoDir], repoDir);
	const found = result.extensions.some((e) => String(e.sourceInfo?.path ?? "").includes("extensions"));
	ok("pi.extensions manifest resolved and factory loaded", found);
	ok("no load errors", result.errors.length === 0);
}

// give async withTimeout tests a beat
await new Promise((r) => setTimeout(r, 50));

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
