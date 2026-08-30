# Configuration

All knobs are environment variables (`PI_CTX_*`). Nothing else is required —
the extension works out of the box with the defaults shown.

Set them in your shell profile, e.g.:

```bash
# ~/.bashrc or ~/.zshrc
export PI_CTX_AMNESIA_MIN_TOKENS=500     # tag fewer, larger results
export PI_CTX_AUX_MODEL=anthropic/claude-haiku-4.5
```

## Reference

| Variable | Default | Meaning |
|---|---|---|
| `PI_CTX_OFF` | `0` | Master switch. `1` disables the entire extension (factory returns immediately). |
| `PI_CTX_BASH` | `1` | Enable bash output interception. |
| `PI_CTX_BASH_MIN_TOKENS` | `2000` | Summarize bash output above this many tokens. |
| `PI_CTX_BASH_MAX_SUMMARY_TOKENS` | `1024` | Output cap for the digest. |
| `PI_CTX_BASH_FALLBACK_BYTES` | `3000` | Tail shown when the summarizer is unavailable. |
| `PI_CTX_AMNESIA` | `1` | Enable meta-amnesia tagging/pruning. |
| `PI_CTX_AMNESIA_MIN_TOKENS` | `250` | Tag only results at least this large. `0` = tag every read/grep/find/ls (each tag costs one low-effort model call). |
| `PI_CTX_AMNESIA_MAX_CHARS` | `6000` | How much of a result the tagger sees. |
| `PI_CTX_TAG_MAX_TOKENS` | `24` | Tagger output cap (it only returns RETAIN/DROP). |
| `PI_CTX_LAZY` | `1` | Lazy tool loading via `find_capability`. |
| `PI_CTX_LAZY_SKILLS` | `1` | Strip the skill catalog from the system prompt; skills load only via `find_capability`. |
| `PI_CTX_SKILL_MAX_CHARS` | `8000` | Cap on injected `SKILL.md` content. |
| `PI_CTX_AUX_MODEL` | *(active model)* | Override the aux model as `provider/id`. |
| `PI_CTX_AUX_TIMEOUT_MS` | `20000` | Timeout for aux model calls. |
| `PI_CTX_STATS_WIDGET` | `1` | Show the savings widget above the editor. |
| `PI_CTX_LOG_FILE` | `~/.pi/agent/logs/ctxwm.jsonl` | JSONL event log path. |

## Feature flags

Every mechanism can be disabled independently:

```bash
export PI_CTX_BASH=0        # stop summarizing bash output
export PI_CTX_AMNESIA=0     # stop tagging/pruning (removes the per-tool latency)
export PI_CTX_LAZY=0        # stop managing tools (find_capability stays, but nothing is activated)
export PI_CTX_LAZY_SKILLS=0 # keep skills listed in the system prompt as pi does by default
export PI_CTX_STATS_WIDGET=0 # hide the widget (accounting still runs, see /ctx-stats)
```

## Choosing an aux model

By default the aux model is **your active model** run with
`reasoningEffort: "low"` — a cheap/fast pass on the same provider, no extra
credentials. For a genuinely cheaper pass, pin a small model:

```bash
export PI_CTX_AUX_MODEL=anthropic/claude-haiku-4.5
export PI_CTX_AUX_MODEL=google/gemini-3.1-flash-lite
export PI_CTX_AUX_MODEL=ollama/qwen3.8:latest   # local + free
```

The value must be resolvable by your `ctx.modelRegistry` (built-in catalog or
`~/.pi/agent/models.json`), and requires an API key for that provider.
Bare ids fall back to the active model's provider.

## Tuning for latency

Each intercepted bash output and each tagged tool result adds one aux model
round trip to the tool loop. To cut it down:

- Raise `PI_CTX_AMNESIA_MIN_TOKENS` (e.g. 500–1000) so trivial reads are
  never tagged.
- Raise `PI_CTX_BASH_MIN_TOKENS` if you mostly care about very large outputs.
- Lower `PI_CTX_AUX_TIMEOUT_MS` if a slow aux model is worse than a truncated
  fallback.
