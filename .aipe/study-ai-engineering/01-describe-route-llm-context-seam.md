# The "describe my route" LLM-context seam

**Industry name(s):** LLM context assembly / data-to-text generation
("describe the data") · **Type label:** Project-specific (future-state)

> **Status: NOT BUILT.** This seam does not exist in the repo. flattr makes
> zero LLM calls (see `00-overview.md` for the verification grep). This file
> teaches the *pattern* and then pins down the *exact* file and line where the
> feature would attach if the spec's "describe my route" note
> (`docs/flattr-spec.md:254`) were ever built. Read every box marked
> `(PLANNED)` as hypothetical.

---

## Zoom out, then zoom in

flattr already computes everything a human would want said about their route —
it just renders it as numbers in a card. Here's the system today, with the
*one* place an LLM would slot in marked:

```
  Zoom out — where "describe my route" would live

  ┌─ UI layer (mobile/) ──────────────────────────────────────────┐
  │  RouteSummaryCard.tsx                                          │
  │    renders: "3.2 km · 48 m climb · 2 steep segments"          │
  └───────────────────────────▲───────────────────────────────────┘
                              │ RouteSummary object
  ┌─ Engine layer (features/) │───────────────────────────────────┐
  │  routing/summary.ts                                           │
  │    routeSummary(graph, path, userMax) → {distanceM,           │
  │                                          climbM, steepCount}   │
  └───────────────────────────┬───────────────────────────────────┘
                              │ (PLANNED) feed this object as context
  ┌╴ AI layer (DOES NOT EXIST) ▼ ╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶┐
  ┊  describeRoute(summary) → "Mostly flat — one short hill near  ┊
  ┊                            the end. You'll climb about 48 m." ┊
  └╴╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶┘
```

**Zoom in.** The pattern is *data-to-text*: you have a small, fully-computed,
trustworthy structured object, and you want a fluent sentence a human can read
at a glance. The LLM's only job is phrasing. It does not compute, does not
decide, does not retrieve. The question it answers is narrow: *"say these three
numbers like a helpful person would."*

---

## The structure pass

**Layers:** UI (`RouteSummaryCard.tsx`) → Engine (`summary.ts`) →
*(planned)* AI (`describeRoute`). Three nested levels.

**Axis — trace `trust` down the stack.** Trust is the right x-ray here because
it's exactly what flips at the seam:

```
  One axis (trust) traced down the layers

  ┌─────────────────────────────────────┐
  │ Engine: routeSummary() output       │  → TRUSTED
  │   numbers from a deterministic A*    │    (provably correct)
  └─────────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ (PLANNED) AI: describeRoute()   │  → UNTRUSTED
      │   LLM phrasing of those numbers  │    (may hallucinate)
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ UI: RouteSummaryCard         │  → must show BOTH
          └─────────────────────────────┘    (numbers + prose)
```

**The seam that matters:** the boundary between `summary.ts` and the planned
`describeRoute`. Trust flips there — above it, the climb figure is computed and
correct; below it, the *sentence* about the climb is a model's best guess. That
flip is the whole reason the UI must keep rendering the raw numbers next to any
generated prose: if the LLM says "almost no climbing" and the real `climbM` is
48 m, the user needs the 48 to catch the lie.

---

## How it works

### Move 1 — the mental model

You already know `JSON.stringify(obj)` turns a typed object into a string a
machine reads. Data-to-text is the same move aimed at a *human*: structured
object in, fluent sentence out. The strategy is **the LLM phrases, the code
computes** — never the reverse.

```
  Pattern — data-to-text (one-shot, no loop)

  {distanceM, climbM, steepCount}      ← TRUSTED facts
            │
            ▼  embed verbatim into prompt
  ┌───────────────────────────────┐
  │ "Describe this route in one    │
  │  friendly sentence. Use ONLY    │
  │  these facts: <object>"         │
  └───────────────┬───────────────┘
            │  single LLM call, temperature low
            ▼
  "Mostly flat with one short climb near the end."
            │
            ▼  show ALONGSIDE the raw numbers, never instead of
  RouteSummaryCard
```

### Move 2 — the step-by-step walkthrough

**Step 1 — compute the facts (this already exists).** `routeSummary` walks the
path's edges and sums positive directed rise into `climbM`, counts flagged-steep
edges into `steepCount`, reads `distanceM` off the path. This is deterministic
and correct. Nothing about adding an LLM changes this step — it's the input.

```
  Step 1 — facts are computed BEFORE any model is touched

  path.edges ──► for each edge: directedRise > 0 ? add to climbM
            ──► steepCount = path.steepEdges.length
            ──► distanceM  = path.lengthM
            ═══► RouteSummary  (the trusted payload)
```

**Step 2 — assemble the prompt (planned).** Bridge from a React `fetch()`: you
build a request body before you call. Here the body is a prompt string with the
`RouteSummary` interpolated and a hard instruction — *use only these facts.*
The boundary condition: if you let the model invent context ("scenic", "busy"),
it will, and it'll be wrong, because flattr's data has no such field.

**Step 3 — single call, low temperature (planned).** One call, no loop. Bridge
from temperature=0 classifiers: you want phrasing variety low and factual
consistency high, so temperature stays near 0. The boundary condition: this is
*not* a chat — there's no conversation, no streaming necessity (the sentence is
short), no tools.

```
  Step 3 — layers-and-hops for the planned call

  ┌─ Engine ─────┐ hop 1: RouteSummary  ┌─ AI client ───┐
  │ summary.ts   │ ───────────────────► │ describeRoute │
  └──────────────┘                      └──────┬────────┘
                                          hop 2│ POST prompt
                                               ▼
                                        ┌─ Provider ─────┐
                                        │ LLM API        │
                                        └──────┬─────────┘
  ┌─ UI ─────────┐ hop 4: sentence ◄──────────┘ hop 3: text
  │ RouteSummary │
  │ Card.tsx     │  ← renders sentence + the raw numbers
  └──────────────┘
```

**Step 4 — render both (planned).** The card shows the generated sentence *and*
the numbers. The numbers are the receipt. Drop them and you've made the trusted
layer invisible behind the untrusted one — the exact mistake the structure-pass
trust-flip warns about.

#### Move 2.5 — current state vs future state

This is the whole point of the file, so here it is side by side:

```
  Phase A (NOW)                  Phase B (PLANNED — describe route)
  ───────────────────────────    ──────────────────────────────────
  routeSummary() → numbers       routeSummary() → numbers  (UNCHANGED)
        │                              │
        ▼                              ├──────────────┐
  RouteSummaryCard               (numbers)      describeRoute(summary)
  shows "3.2 km · 48 m"                │              │ LLM, temp~0
                                       ▼              ▼
                                 RouteSummaryCard shows
                                 "3.2 km · 48 m" + sentence
```

**What does NOT have to change:** `features/routing/summary.ts` — not one line.
The `RouteSummary` type is already the perfect LLM context payload: small,
typed, trusted, no PII, no untrusted free text (it's pure numbers). That's the
takeaway. The engine was built data-to-text-ready by accident of good design.

**What it costs:** one new module (`features/describe/` or similar), one
provider dependency + key, a token bill per route described (trivial here — the
payload is three numbers), and the obligation to keep rendering the raw numbers.

### Move 3 — the principle

Put the LLM at the *boundary* where data becomes human-readable, never in the
path where data becomes correct. flattr computes correctness deterministically
and provably; the model's only job is the last inch — phrasing. Keep that inch
small and the trust-flip stays contained.

---

## Primary diagram

The full recap — the planned describe-route flow, every layer and trust state
labeled:

```
  "Describe my route" — full planned flow (NONE OF THIS IS BUILT)

  ┌─ Engine (features/routing/summary.ts) ─────── TRUSTED ────────┐
  │  routeSummary(graph, path, userMax)                          │
  │    → { distanceM: 3200, climbM: 48, steepCount: 2 }           │
  └───────────────────────────┬───────────────────────────────────┘
                              │ context payload (numbers only)
  ┌╴ AI (PLANNED describeRoute) ╶╶╶╶╶╶╶╶╶╶╶ UNTRUSTED ╶╶╶╶╶╶╶╶╶╶╶┐
  ┊  prompt: "one friendly sentence, USE ONLY THESE FACTS: {...}" ┊
  ┊  single call · temperature ~0 · no tools · no loop            ┊
  ┊    → "Mostly flat, one short climb near the end (~48 m)."     ┊
  └╴╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶┬╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶┘
                              │ sentence
  ┌─ UI (RouteSummaryCard.tsx) ▼──────────────────────────────────┐
  │  renders sentence ABOVE the raw numbers (the receipt)         │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** There is exactly one, and it does not exist yet: the spec's
"describe my route" note. The trigger would be *after* a route resolves, when
the user taps the summary card. It runs once per resolved route, not per frame,
not per tile — so it's a cold-path call, which is why a single non-streaming
request is fine.

**The anchor — the trusted payload that already exists.** This is the only real
code in this file. It's the input the planned feature would consume verbatim:

```
  features/routing/summary.ts  (lines 5, 11–20)

  export type RouteSummary =                      ← THIS is the LLM
    { distanceM: number; climbM: number;            context payload.
      steepCount: number };                          Typed, tiny, trusted.

  export function routeSummary(graph, path, _userMax): RouteSummary {
    let climbM = 0;
    for (let i = 0; i < path.edges.length; i++) {  ← walk path edges
      const edge = edgeById(graph, path.edges[i]);
      const fromNode = path.nodes[i];
      const directedRise =                          ← signed by travel dir:
        fromNode === edge.fromNode                    uphill is positive
          ? edge.riseM : -edge.riseM;
      if (directedRise > 0) climbM += directedRise; ← sum ONLY uphill
    }
    return { distanceM: path.lengthM, climbM,        ← the object you'd
             steepCount: path.steepEdges.length };     hand to describeRoute
  }
       │
       └─ Nothing here calls an LLM and nothing should. The function is
          pure and deterministic. A describeRoute() would take its RETURN
          VALUE as input — `summary.ts` itself stays untouched. That zero-
          diff property is what makes this a clean seam.
```

Note `_userMax` is currently unused (leading underscore). A describe feature
that wanted to say *"this is steeper than your comfort setting"* would start
using it — that's the one line that might change, and only in a future version.

---

## Elaborate

Data-to-text is one of the oldest, safest LLM applications — older than chat
UIs, going back to template-based natural-language-generation systems for
weather and sports reports. LLMs made it fluent instead of stilted. It's safe
*specifically because* the facts are computed elsewhere and the model only
phrases them; the failure mode (hallucinating a fact) is caught by showing the
facts alongside. Adjacent concepts worth reading next: structured outputs
(constraining the model to *cite* the numbers it used), and the
prompt-injection concern — which in flattr arrives through the *other* seam
(`02-nl-destination-parse-seam.md`), because `RouteSummary` is pure numbers and
carries no attacker text, while geocoder labels do.

---

## Interview defense

**Q: "Your maps app has no AI. If you added one LLM feature, what and where?"**

Lead with the call, then the reason. *"Describe-my-route — a data-to-text
sentence off the route summary. I'd attach it at `features/routing/summary.ts`,
which already returns a typed `{distanceM, climbM, steepCount}`. The LLM only
phrases; the engine still computes. Critically, the seam is a trust boundary —
so the UI keeps showing the raw numbers next to the sentence as a receipt."*

```
  the one-sentence whiteboard sketch

  summary.ts (TRUSTED nums) ──► describeRoute (UNTRUSTED prose) ──► card
                                                                   shows BOTH
```

Anchor: *the model phrases, the code computes — keep the LLM at the boundary,
never in the correctness path.*

**Q: "Why not let the LLM compute the climb too?"** Because A* with an
admissible heuristic gives a provable optimum and the Dijkstra oracle in the
tests checks it. An LLM gives a probabilistic guess. You'd trade a proof for a
hallucination risk on a number you already have for free.

---

## Validate

- **Reconstruct:** draw the three-layer diagram (UI / Engine / planned AI) and
  mark which layer is trusted vs untrusted, without looking. Trust flips at the
  `summary.ts` → `describeRoute` boundary.
- **Explain:** why does `RouteSummary` (`features/routing/summary.ts:5`) make a
  good LLM context payload? (Small, typed, trusted, no untrusted free text.)
- **Apply:** the spec wants "steeper than your comfort setting" in the
  sentence. Which currently-unused parameter in `routeSummary`
  (`summary.ts:11`) would the feature need? (`_userMax`.)
- **Defend:** someone proposes letting the LLM compute `climbM` to "save a
  pass." Argue against it using the Dijkstra oracle and the A* admissibility
  guarantee.

---

## See also

- `00-overview.md` — the full concern walk and the no-AI verdict.
- `02-nl-destination-parse-seam.md` — the other real seam (geocode/search), and
  where untrusted OSM text actually enters.
- `ai-features-in-this-codebase.md` — the honest "there are none" file.
- `.aipe/study-system-design/` — `summary.ts` as part of the routing flow.
- `.aipe/study-testing/` — the Dijkstra-vs-A* oracle this file cites.
