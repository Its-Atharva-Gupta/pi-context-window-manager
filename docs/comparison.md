# A/B testing: with vs. without

Measure the extension's real effect on usage. Run the same task twice — once
with the extension, once disabled — and compare actual provider usage from
the session/event stream.

## One-off runs

With the extension (run inside a project where it's installed):

```bash
pi --model ollama/qwen3.8:latest --mode json --no-session \
  "list the files here, then read the two biggest ones and summarize them" \
  > /tmp/ctxwm-with.jsonl 2>/dev/null
```

Without it (disable via env — keeps project context identical):

```bash
PI_CTX_OFF=1 pi --model ollama/qwen3.8:latest --mode json --no-session \
  "list the files here, then read the two biggest ones and summarize them" \
  > /tmp/ctxwm-without.jsonl 2>/dev/null
```

> `--mode json` prints every agent event as JSONL; each assistant message
> carries a `usage` object with `input`, `output`, `cacheRead`, `cacheWrite`.
> `--no-session` avoids polluting your session list. `--model` pins the same
> model for both runs.

## Compare real usage

```python
import json
for f in ["/tmp/ctxwm-with.jsonl", "/tmp/ctxwm-without.jsonl"]:
    u = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0}
    for line in open(f):
        try:
            e = json.loads(line)
        except Exception:
            continue
        m = e.get("message", {})
        if m.get("usage"):
            u["calls"] += 1
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                u[k] += m["usage"].get(k, 0)
    print(f.split("/")[-1], u)
```

## See what the extension claims it saved

```bash
PI_CTX_LOG_FILE=/tmp/ctxwm-with.log   # add to the "with" run, then:
python3 - <<'EOF'
import json
for line in open("/tmp/ctxwm-with.log"):
    e = json.loads(line)
    if e.get("kind") == "turn":
        print("ctxwm saved:", e["total"], "(bash", e["bash"], "amnesia", e["amnesia"], "lazy", e["lazy"], ")")
EOF
```

## What to look for

- **`input` + `cacheRead` tokens**: the main metric — fewer tokens fed to the
  model per call, and (the point of the cache-safe design) a high `cacheRead`
  share over multi-turn runs.
- **`calls`**: roughly comparable; the extension shouldn't change the number
  of LLM round trips, only their size.
- **Widget numbers vs. measured `input`**: the widget's `total` is *context
  avoided*; the measured `input` difference is the real effect, minus the aux
  model's own input tokens.

## Caveats

- **Non-determinism.** The model won't take the identical path in both runs.
  Use a task with several tool calls, and/or run each variant 2–3 times and
  compare totals.
- **Aux cost.** The "with" run spends extra tokens on summarizer/tagger
  calls (small, low-reasoning). For a strict net comparison, add estimated
  aux input tokens (`(prompt + content) / 4` per aux call) to the "with"
  side — they appear in the event log as `amnesia-tag` and `bash`/`bash-fallback`
  events.
- **Same project, same model, same prompt** for a fair baseline; `PI_CTX_OFF=1`
  is a cleaner "without" than removing files.
