# Token accounting

The extension reports tokens saved per mechanism, per turn, and cumulatively.
This document explains exactly what each number means — and its limits.

## The numbers

| Number | Definition | Computed as |
|---|---|---|
| **bash** | Context tokens the main agent *didn't* see | `estimateTokens(raw output) − estimateTokens(digest)`, per intercepted result |
| **amnesia** | Context tokens of messages actually removed | pi's `estimateTokens(message)` for every message (or stripped tool-call block) dropped from the tail |
| **write** | Context tokens of the stripped file content, minus the fact line | `estimateTokens(file content) − estimateTokens(fact)`, per compressed write |
| **lazy** | Estimated tokens *not injected* into this turn's context | Sum of `(name + description + parameters JSON + guidelines) / 4` for inactive tool specs, plus the stripped skill-catalog section |
| **total** | bash + amnesia + lazy + write | — |

Token estimates use pi's own heuristic: **chars/4**, conservative
(over-estimates). It's an estimate, not provider tokenizer output.

## Where you see it

| Surface | What |
|---|---|
| **Widget** (`ctxwm`) | One line above the editor, updated at each turn end |
| `/ctx-stats` | Cumulative + last turn breakdown, turn count, log path |
| **Event log** | `~/.pi/agent/logs/ctxwm.jsonl` (or `PI_CTX_LOG_FILE`) |
| **Session snapshot** | `ctxwm-stats` custom entries — persisted, restored on reload/`/resume`, never sent to the LLM |

## Log format

Every interesting event is one JSON line:

```json
{"ts":"2026-08-30T06:10:19.549Z","kind":"amnesia-tag","toolCallId":"call_...","tool":"read","decision":"RETAIN","tokens":485}
{"ts":"2026-08-30T06:10:19.550Z","kind":"turn","turn":1,"bash":0,"amnesia":0,"lazy":0,"total":0,"cumulative":{"bash":0,"amnesia":0,"lazy":0,"total":0}}
{"ts":"2026-08-30T06:09:45.741Z","kind":"lazy","avoidedTokens":877}
{"ts":"2026-08-30T06:06:20.401Z","kind":"bash","toolCallId":"call_...","command":"...","originalTokens":9000,"summaryTokens":300,"saved":8700}
```

Event kinds: `bash`, `bash-fallback`, `amnesia-tag`, `amnesia-remove`,
`write`, `write-inject-failed`, `lazy`, `turn`.

## Honest caveats

- **bash/amnesia savings don't subtract aux cost.** Every digest and every
  tag is itself a model call with input tokens. The widget shows *context
  avoided*, not *total cost reduction*. For a full cost picture, add the
  aux input tokens (estimate: `(prompt + content) / 4`) to the "with" side.
  See [comparison.md](comparison.md).
- **amnesia counts only actual removals.** A RETAIN decision (or a DROP that
  couldn't be pruned because it ended up mid-array) adds 0. This is
  deliberate: only what the model stops seeing counts.
- **write savings count the file content, not the fact.** The stripped
  `content` argument is the saving; the ~15-token fact line is the cost of
  keeping working memory. Facts themselves are tiny and persist for the
  whole session.
- **lazy is an avoided-injection estimate.** It estimates the specs and
  skill catalog that *would have* been in the prompt if nothing were lazy. It
  is a model of savings, not a metered value — and it's `0` if your active
  tool set already covers the catalog and you have no skills.
- **Widget totals reset on session start** (per-session accounting); the
  persisted snapshot restores cumulative totals from the current branch.
- **Aux model latency isn't counted**, but it's the real cost of the
  mechanisms — see [configuration.md](configuration.md#tuning-for-latency).
