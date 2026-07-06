# slang-workflows — launch / promo media

Source files + rendered assets for the launch visuals. Self-contained (system
monospace, no external assets); open the `.html` directly or re-render below.

| Asset | Content | Use |
|---|---|---|
| **`slang-workflows.gif`** | **Real, token-free run.** A faithful replay of an actual `implement-feature.slang` run through the deterministic executor (`FakeDispatcher`, 10 rounds — design → @Human approve → implement → ✗ changes → fix → ✓ approve → converged, **0 coordination LLM calls**). Source in [`demo/`](./demo). | Tweet-1 / README-hero **motion** — the guaranteed review loop running deterministically. |
| **`explainer-card`** | **How it works** (declare → non-LLM executor → agents) + **what the runtime guarantees** (static analysis, typed contracts, tool-scoping, provable termination, auto diagrams) + the honest **coordination-cost** comparison (0 vs ~0 vs 98–154k). | Lead **still** — the proof card. |
| **`workflow-poster`** | A real, syntax-highlighted `.slang` file (`04-pipeline.slang`) with the validate/guarantee footer. | "What a workflow *is*" shot — slang's declarative identity. |
| **`banner.txt`** | The ANSI-Shadow `slang` wordmark (also the README header). | Brand mark. |

> **Honesty note.** The numbers are real and follow [`../benchmark/results/RESULTS.md`](../benchmark/results/RESULTS.md):
> per-run **coordination** LLM tokens are **0** for the slang executor (deterministic code) and
> ~98–154k for a turn-by-turn LLM coordinator; *agent work* tokens are comparable across arms and
> excluded. slang and native dynamic workflows both reach working results at ~0 coordination cost —
> the difference is **what's guaranteed** (static-checked, tool-scoped, contract-enforced,
> provably-terminating, auto-diagrammed), not a quality %. The GIF's agent *outputs* are stubbed for a
> token-free capture; the executor **coordination is 100% real**.

## Regenerate the GIF

Needs [`vhs`](https://github.com/charmbracelet/vhs) (+ `ttyd`, `ffmpeg`). From the plugin root:

```sh
vhs media/demo/slang-workflows.tape          # → media/slang-workflows.gif
```

`demo/slang` replays the captured real run; the `.tape` types `slang run …` and plays it, so the
render is deterministic (no live agents, no server). To reproduce the underlying **real** executor
run yourself (token-free, via `FakeDispatcher`), see the conformance suite in
[`../server/test/conformance.test.ts`](../server/test/conformance.test.ts).

## Regenerate the PNGs

Rendered at 2× with headless Chrome, then trimmed to an even margin:

```sh
for a in explainer-card workflow-poster; do
  PROF=$(mktemp -d)
  { printf '<!doctype html>\n<meta charset="utf-8">\n'; cat media/$a.html; } > /tmp/$a.html
  google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --user-data-dir="$PROF" --window-size=1240,1180 \
    --screenshot=media/$a.png "file:///tmp/$a.html"
  rm -rf "$PROF"
  convert media/$a.png -fuzz 4% -trim +repage -bordercolor '#08090f' -border 60 media/$a.png
done
```
