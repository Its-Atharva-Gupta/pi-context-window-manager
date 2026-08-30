<div align="center">

# pi-context-window-manager

**Intelligent context window management for [pi](https://pi.dev)**

Summarizes huge bash output before it enters context · silently prunes
forgotten tool results · lazily loads tools and skills on demand ·
never breaks your prompt cache · tells you exactly how many tokens it saved.

</div>

---

## Why?

Long tool outputs, forgotten reads, and a wall of preloaded tool specs all
burn context window — and worse, they invalidate the KV prompt cache that
keeps long sessions fast. This extension fixes all three:

1. **Bash output interception** — outputs over 2000 tokens are digested by a
   low-reasoning pass *before* they can enter context. The agent never sees
   the raw output.
2. **Meta-amnesia pruning** — `read`/`grep`/`find`/`ls` results are silently
   classified *retain / drop* by an out-of-band model call. The Q&A never
   enters the conversation, and dropped results are pruned from the tail —
   the agent has no memory the exchange ever happened.
3. **Lazy skill/tool loading** — only one meta-tool (`find_capability`) is
   preloaded. Everything else is injected on demand and removed after the
   task.
4. **Cache-safe** — pruning only touches a contiguous tail suffix. The stable
   prefix (system prompt + early conversation) is byte-identical across
   turns, so the KV prompt cache on earlier turns is never invalidated.
5. **Token accounting** — per-turn and cumulative savings per mechanism, in a
   live widget, `/ctx-stats`, a JSONL log, and a persisted snapshot.

## Install

```bash
pi install npm:pi-context-window-manager
```

Or try it for one run without installing:

```bash
pi -e npm:pi-context-window-manager
```

Then `/reload` in pi. Verify with `/ctx-stats`.

> Zero configuration required. All knobs are `PI_CTX_*` environment
> variables — see [docs/configuration.md](docs/configuration.md).

## Quick start

Nothing to set up. The extension hooks pi's event pipeline automatically:

- Run `seq 1 100000` in bash → you get a digest, not 100k lines.
- Read a large file → it's silently tagged; if the tagger says *drop* and
  nothing depended on it, it's pruned before the next LLM call.
- Ask the agent for a tool it doesn't have → it calls `find_capability` to
  load it on demand.
- Watch the `ctxwm` widget above the editor → it shows live savings.

```
ctxwm saved 12.7k tok (bash 12.7k · amnesia 0 · lazy 877)
```

## Documentation

| Document | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it hooks pi's event pipeline, the cache-safety invariant, code map |
| [docs/configuration.md](docs/configuration.md) | Every `PI_CTX_*` variable, feature flags, aux model selection |
| [docs/accounting.md](docs/accounting.md) | What the savings numbers mean, how they're computed, honest caveats |
| [docs/comparison.md](docs/comparison.md) | A/B test the extension against a baseline and measure real usage |

## Features at a glance

| Mechanism | Hook | What happens |
|---|---|---|
| Bash summarization | `tool_result` (before result enters context) | Output > threshold → low-reasoning digest; raw bytes never enter session or context |
| Meta-amnesia | `tool_result` + `context` | Out-of-band retain/drop classification; DROP results pruned from the tail |
| Lazy tools | `find_capability` tool + `setActiveTools` | Tool spec injected on demand, removed at the next user message |
| Lazy skills | `before_agent_start` | Skill catalog stripped from system prompt; SKILL.md injected on demand |
| Token accounting | `turn_start`/`turn_end` | Per-turn savings persisted, logged, and displayed |

## How it works (30 seconds)

pi fires `tool_result` *before* a tool result message is created, and fires
`context` *before* every LLM call with a copy of the messages about to be
sent. Those two seams are everything:

- Replace `content` in `tool_result` → the raw output never becomes a message.
- Filter the tail of the messages in `context` → dropped content is gone from
  what the model sees, without touching earlier (cache-hot) turns.

The full picture is in [docs/architecture.md](docs/architecture.md).

## FAQ

**Is it expensive?** Each intercepted bash output and each tagged tool result
costs one low-reasoning model call on your active model. Set
`PI_CTX_AUX_MODEL=anthropic/claude-haiku-4.5` (or similar) for a genuinely
cheap pass, or raise `PI_CTX_AMNESIA_MIN_TOKENS` to tag less.

**Is my context actually cached?** Only tail suffixes are ever pruned, so the
prefix (system prompt + early conversation) is identical across requests.
See the cache-safety section in [docs/architecture.md](docs/architecture.md).

**Are the raw bytes deleted from disk?** No — `ctx.sessionManager` is
read-only, so pruning affects what the LLM sees, not the session `.jsonl`.
The same filter re-applies after `/resume`.

**Does the agent know it was tagged?** No. Tagging runs as a separate model
call that never enters the messages array — there is nothing to scrub.

**How do I know it saved anything?** `/ctx-stats`, the `ctxwm` widget, and
`~/.pi/agent/logs/ctxwm.jsonl`. See [docs/accounting.md](docs/accounting.md).

## Development

```bash
npm install
npm run typecheck   # strict TS over extensions/
npm test            # smoke tests via pi's own loader (jiti)
npm run pack        # preview the npm tarball
```

The smoke tests exercise the pruning algorithm, cache-safety edge cases, the
lazy-loading lifecycle, bash interception fallbacks, and token accounting —
no model calls, no pi install required beyond `npm install`.

## License

MIT — see [LICENSE](LICENSE).
