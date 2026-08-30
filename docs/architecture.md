# Architecture

This document explains exactly where the extension hooks into pi and why the
design keeps your prompt cache intact.

## The two seams everything hangs on

```
user message
   │
   ▼
before_agent_start  ◄── lazy: strip skill specs, restore base tools
   │
   ▼
LLM call #1 ──► assistant msg (may contain tool calls)
   │
   ▼
tool executes
   │
   ├─► tool_result        ◄── bash: replace content with digest
   │        (fires BEFORE  │   amnesia: classify result retain/drop (out-of-band)
   │    the result message │
   │    is created)        │
   ▼                       ▼
context event          ◄── amnesia: prune DROP results from the tail
   │        (fires BEFORE
   │    every LLM call)
   ▼
LLM call #2 ──► assistant msg
   │
   └─► turn_end           ◄── stats: roll up per-turn savings
```

1. **`tool_result` fires before the result message is created.** Replacing
   `content` there means the raw bytes *never become a message* — nothing to
   delete later, and the session file never contains them.
2. **`context` fires before every LLM call** with a deep copy of the messages
   about to be sent. Filtering there changes what the model sees without
   touching the session store.

## Module map

| File | Responsibility |
|---|---|
| `extensions/index.ts` | Factory: wires config → stats → amnesia → bash → lazy; `/ctx-stats`; per-turn accounting; stats restore on session start |
| `extensions/config.ts` | `PI_CTX_*` environment configuration with defaults |
| `extensions/model.ts` | Out-of-band aux model calls (active model, `reasoningEffort: "low"`); fail-safe `undefined` on any failure |
| `extensions/bash.ts` | Requirement 1: bash output interception + sanitization |
| `extensions/amnesia.ts` | Requirement 2: silent tagging + tail-only pruning |
| `extensions/write.ts` | Requirement 4: write compression into persistent facts |
| `extensions/lazy.ts` | Requirement 3: `find_capability` meta-tool, catalogs, skill stripping |
| `extensions/stats.ts` | Requirement 5: token accounting, widget, persistence |
| `extensions/util.ts` | Text extraction, chars/4 token estimation, abort-aware timeouts, JSONL log |

## Mechanism 1 — Bash output interception

When bash finishes, its `tool_result` fires. The handler:

1. Extracts the text and estimates tokens (chars/4 — same heuristic pi uses).
2. Below `PI_CTX_BASH_MIN_TOKENS` (default 2000) → pass through untouched.
3. Otherwise → an out-of-band digest call, then `{ content: [digest] }`.
4. The built-in truncation note (which embeds the discarded output's temp
   path) is sanitized out of the text before it reaches the summarizer, and
   `fullOutputPath`/`truncation` are stripped from details — nothing points
   back at the raw bytes.
5. If the digest call fails → a truncated tail is shown instead. Raw output
   still never fully enters context, even in the failure path.

## Mechanism 2 — Meta-amnesia

**Silent tagging (stage 1).** For `read`/`grep`/`find`/`ls` results (and
skill loads), the extension makes its *own* out-of-band model call with just
the content and a structured prompt, asking for `{"decision": "RETAIN"}` or
`{"decision": "DROP"}`. That exchange never enters the messages array — there
is no question/response to scrub, so the main agent genuinely never knows it
was asked. Fail-safes:

- tagger unavailable/timeout → **RETAIN** (never drop on uncertainty)
- error results are never tagged
- results below `PI_CTX_AMNESIA_MIN_TOKENS` are never tagged

**Pruning (stage 2).** DROP results are recorded by `toolCallId` and removed
in the `context` handler, subject to the cache-safety invariant below.

## Cache-safety invariant (Requirement 4)

The `context` handler only strips a **maximal contiguous suffix** of the
messages array:

- trailing `toolResult` messages tagged DROP, plus
- tool-call-only assistant messages whose every call was dropped, plus
- the matching `toolCall` blocks stripped from the *owning* assistant message
  (scanning back past kept results of the same parallel round).

Everything before that boundary is byte-identical to the previous request, so
the stable prefix (system prompt + early conversation) produces identical KV
cache entries every turn. Only the just-executed tool round is rewritten —
exactly the region that would change anyway.

Consequences (deliberate):

- A DROP result that ended up **mid-array** (a later message already built on
  it) is **retained**. History is never rewritten.
- A **mixed parallel round** (some results kept, some dropped) is retained
  wholesale — dropping only part of it would punch a hole mid-array.

## Mechanism 3 — Lazy skill/tool loading

- **Tools.** The full catalog (`pi.getAllTools()`) is searchable, but only
  the active set appears in the system prompt. `find_capability` activates
  the best match via `pi.setActiveTools([...])` — the spec lands in context
  and the tool becomes callable. At the start of the *next user message*
  (task boundary) the base tool set is restored, removing the spec.
- **Skills.** The `<available_skills>` section is stripped from the system
  prompt each turn in `before_agent_start`, using the exact string pi builds
  (`formatSkillsForPrompt`), so nothing is listed up front. When a skill is
  chosen, its `SKILL.md` is returned as the tool result and flagged for
  meta-amnesia pruning — unused injections are dropped again.
- `find_capability` itself is always active.

## Mechanism 4 — Writes → persistent facts

The full file content of a `write` call lives in the assistant message's
`toolCall` arguments — and stays in context for the rest of the session. Two
things happen instead:

1. **Strip at the tail.** In the `context` handler, the `content` argument is
   removed from write toolCalls in the *last* assistant message (path stays).
   Because that message was the output of the previous LLM call — never its
   input — the cache prefix (everything before it) is untouched.
2. **Compress into a fact.** The file is compressed into one line by the
   out-of-band aux model and injected as a tiny custom message
   (`ctxwm-fact`) that is never pruned and survives `/resume`:
   `[Wrote src/model.py — CNN architecture, 3 conv layers, ~80 lines]`
   If the model call fails, a heuristic fact (path + docstring/comment +
   line count) is used — memory is never lost.

**Why tail-append instead of a growing block at the top?** Inserting into the
prefix would shift every later token, invalidating the *entire* KV cache on
each new fact. Appending at the tail keeps the prefix byte-identical; each
fact costs ~15 tokens and accumulates as a chronological "what I've done"
log.

Writes below `PI_CTX_WRITE_MIN_BYTES` pass through untouched (no fact, no
strip). Write args in a *non-last* assistant message are never stripped
(mid-array = cache-unsafe), same tradeoff as amnesia.

## Failure modes

Every aux model path degrades to a safe default — never a crash, never a
blind drop:

| Failure | Bash | Amnesia | Write |
|---|---|---|---|
| No model / no API key | truncated tail shown | RETAIN | heuristic fact (path + docstring + lines) |
| Timeout / abort | truncated tail shown | RETAIN | heuristic fact |
| Malformed tagger reply | — | RETAIN (only `{"decision":"DROP"}` drops) | — |
| Extension error | pi logs, agent continues | same | same |
