# Lost in the Middle
*Industry name: lost-in-the-middle · Type: attention failure mode*

## Zoom out

```
RECALL vs POSITION (the U-curve)
recall
  high │█                                   █
       │██                               ██
       │ ███                           ███
       │   ████        ▼ here        ████
   low │      ███████████████████████
       └──────────────────────────────────────► position in context
          START          MIDDLE            END
        (attended)   (often dropped)    (attended)
```

Long-context models do not read uniformly. Give a model a big stack of context
and ask it to use a fact buried in the middle, and recall sags — even when the
fact is plainly there. Attention concentrates on the beginning and the end. The
practical consequence: *adding more context can lower answer quality* if the
useful part lands in the sag.

You hit the inverse of this in MemoRAG — session memory only helps if the
relevant turn surfaces near where the model is actually looking, not entombed in
the middle of a long transcript.

## How it works

**Move 1 — Position is a feature, not a detail.**

```
SAME FACTS, TWO LAYOUTS
dump order:   [filler][filler][KEY FACT][filler][filler]   ← key in the sag
ranked order: [KEY FACT][supporting][filler] ............ [restate KEY]
                  ▲ front                                      ▲ end
```

Mental model: the model has two spotlights, one at each end. Put what matters
under a spotlight. Order is not cosmetic; it changes what the model can recall.

**Move 2 — Mitigate by retrieving less and placing it well.**

```
PIPELINE
candidates ─► [ retrieve ] ─► [ RERANK ] ─► keep few ─► [ place at edges ]
                                  │                            │
                       relevance, not recall          front-load the answer,
                                                       optionally restate at end
```

Step by step: (1) retrieve a wide candidate set; (2) **rerank** so the most
relevant chunks rise to the top; (3) keep only a few — a short, sharp context
beats a long, diffuse one; (4) order deliberately, putting the load-bearing
chunk at the front (and restating the key constraint at the very end if needed).

**Move 3 — Principle:** *fewer, better-placed tokens beat more, buried ones.*

## In this codebase

**Not yet exercised in flattr.** This failure mode only appears when a long
context contains a needle the model must find. flattr has no retrieval and no
long context — there is nothing to get lost.

If the "Describe my route" feature at `features/routing/summary.ts:11` were
built, its entire context is `{distanceM, climbM, steepCount}` — three numbers,
no middle to lose. The U-curve is irrelevant at this scale. The honest read:
flattr would have to grow a retrieval layer (per-segment elevation notes, turn
lists, nearby POIs from `pipeline/geocode.ts`) before lost-in-the-middle became a
real concern. Today there is **no attachment point** — no long context exists to
mismanage.

## See also
- `01-context-window.md` — the finite box this U-curve plays out inside
- `03-prompt-chaining.md` — splitting work so each step's context stays short
- `pipeline/geocode.ts:52` — where a future retrieval set (POIs) might originate
