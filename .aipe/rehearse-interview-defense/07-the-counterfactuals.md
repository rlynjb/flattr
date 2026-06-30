# Chapter 7 — The Counterfactuals

"What would you do differently if you started today?" The senior move on this
question is to answer it *before* it's asked — to volunteer what you'd
reconsider, because that's the habit of someone who keeps thinking about their
own decisions after they ship. But there's a matching trap: fabricating
regrets for decisions that were obviously right. If you say you'd "change the
hand-rolled router" or "add a database," you've just told the interviewer you
don't understand why those were correct.

This chapter draws the line. Three things in flattr genuinely worth
reconsidering — and three you should *defend, not regret*. Knowing which is
which is the whole skill.

---

## The counterfactuals matrix

This is the chapter's spine: every reconsiderable decision, what you'd change,
and — just as important — the decisions you'd *keep* and refuse to fake a
regret about.

```
  flattr counterfactuals — change these, KEEP those

  ┌─ WOULD CHANGE ──────────────────┬─ WHAT I'D DO INSTEAD ──────────┐
  │ 1. graph.json loaded unvalidated │ schema + adjacency-integrity   │
  │    (loadGraph.ts:10 casts/trusts)│ check at the load seam         │
  ├──────────────────────────────────┼────────────────────────────────┤
  │ 2. elevation provider hardwired   │ ElevationProvider interface so │
  │    into the pipeline (elevation.ts)│ paid API is a swap, not an edit│
  ├──────────────────────────────────┼────────────────────────────────┤
  │ 3. data-loading seam grew         │ design the tile/load boundary   │
  │    organically (tiles bolted on)  │ up front, not after the bug     │
  └──────────────────────────────────┴────────────────────────────────┘

  ┌─ WOULD KEEP — do NOT fake a regret about these ─────────────────────┐
  │ ✓ hand-rolled engine — the custom directional cost IS the project   │
  │ ✓ no backend / no DB — graph is static; a server buys nothing       │
  │ ✓ directional cost A→B ≠ B→A — the entire differentiator             │
  │ ✓ BLOCKED = 1e9 finite — encodes "steep" vs "no route" deliberately │
  └─────────────────────────────────────────────────────────────────────┘
```

The two halves are equally load-bearing. The left side proves you keep
thinking. The right side proves you understand your own good decisions well
enough not to apologize for them.

---

## The framing question — "what would you do differently?"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "If you were starting flattr over today, what would    │
│    you do differently?"                                  │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Two things at once. Do you keep evaluating decisions   │
│   after shipping (the reflective habit)? AND do you know │
│   which decisions were actually RIGHT — or will you      │
│   throw a good one under the bus to sound humble? The    │
│   best answer changes the genuinely-weak things and      │
│   DEFENDS the strong ones in the same breath.            │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice — lead with what you'd keep, then what you'd
change:

> "Let me split it, because some of these I'd keep on purpose and some I'd
> change. I'd *keep* the hand-rolled router — the directional grade cost is
> the whole project and no off-the-shelf engine expresses it. I'd keep the
> no-backend design — the graph is static, a server adds a hop and an outage
> surface for nothing. Those weren't shortcuts; they were the right calls for
> the scope.
>
> What I'd actually change, in order: first, the graph-loading seam.
> `loadGraph` just casts the JSON and trusts it (loadGraph.ts:10) — no
> validation. I'd put a schema and adjacency-integrity check there so a
> malformed artifact fails loudly at load instead of mis-routing later.
> Second, I'd put the elevation API behind a provider interface. Open-Meteo
> was right for a free build, but it's hardwired into the pipeline — swapping
> to a paid provider for reliability means editing the pipeline rather than
> swapping a provider behind a seam. Third, and this is the meta-lesson: I'd
> design the data-loading boundary up front. The tile-loading system grew
> organically, and the disconnected-components bug I hit was a direct symptom
> of that seam being an afterthought. If I'd designed the load boundary
> deliberately from the start, that whole class of bug wouldn't have happened."

The structure — *keep these, change those, here's the meta-lesson* — is the
answer. You're not listing regrets; you're demonstrating judgment about which
decisions earned reconsideration and which didn't.

```
┃ "The senior move is to volunteer what you'd reconsider
┃  before being asked — and to refuse to fake a regret
┃  about the decisions that were right."
```

---

## Counterfactual 1 — validate the graph on load

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Is there anything in the codebase you'd harden?"      │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Do you see your own trust boundaries? The places where │
│   external data crosses into your system unchecked are   │
│   where production bugs live. Naming yours unprompted is │
│   a strong signal.                                       │
└─────────────────────────────────────────────────────────┘
```

> "The one I'd harden first is the graph load. `loadGraph` does
> `graph as unknown as Graph` and returns it (loadGraph.ts:10) — it trusts the
> artifact completely. It's safe in practice because I'm the only producer and
> the file is bundled, not downloaded. But it's a trust boundary with no
> guard: a malformed graph — missing field, broken adjacency, truncated build
> — would sail past load and blow up deep in the search with a confusing
> error, or worse, silently mis-route. I'd add a validation layer right at
> that seam: assert the node and edge shapes, and check adjacency integrity —
> every edge's endpoints exist as nodes, every adjacency entry points at a
> real edge. Then a bad artifact fails immediately with a clear message,
> right where the bad data enters."

This is the strongest counterfactual because it's a genuine gap (Chapter 5's
"the GAP"), it's cheap to fix, and naming it unprompted shows you map your own
trust boundaries.

---

## Counterfactual 2 — the ElevationProvider seam

> "I'd put elevation behind a provider interface. Right now the Open-Meteo
> call is hardwired into `pipeline/elevation.ts`. Open-Meteo was the right
> *choice* — free, build-time only — but the *structure* doesn't isolate it.
> If I wanted to add Google's paid elevation API for reliability, or fall back
> from one provider to another, I'd be editing the pipeline rather than
> registering a provider behind a seam. The fix is an `ElevationProvider`
> interface — `elevationFor(points) → elevations` — with Open-Meteo as one
> implementation and the retry/degrade logic living in the interface, not the
> vendor. Same decision, better seam."

Note the careful distinction you're drawing: the *decision* (free elevation)
was right; the *structure* (no abstraction) is what you'd change. That
separation is exactly the senior framing — you're not regretting the choice,
you're improving the design around it.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'd probably switch to │ "I'd keep Open-Meteo —  │
│ a paid elevation API to  │ free and build-time     │
│ make it more reliable."  │ only was right. What    │
│                          │ I'd change is the       │
│                          │ structure: it's hardwired│
│                          │ into the pipeline. I'd  │
│                          │ put it behind an         │
│                          │ ElevationProvider seam   │
│                          │ so a paid API is a swap, │
│                          │ not an edit. The choice  │
│                          │ was right; the seam      │
│                          │ isn't there."           │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Regrets a GOOD decision  │ Separates the decision  │
│ (free, build-time-only)  │ (keep) from the         │
│ to sound humble. Now the │ structure (change).     │
│ interviewer thinks you   │ Shows you know WHY the  │
│ didn't understand why    │ choice was right AND    │
│ free was correct.        │ how to improve around   │
│                          │ it.                     │
└─────────────────────────┴─────────────────────────┘
```

---

## The follow-up tree — where counterfactuals branch

```
  "What would you do differently?"
        │
        ├─► IF THEY PUSH "would you use a real router (OSRM) now?"
        │     → No, and here's why: the directional grade cost still
        │       isn't expressible in OSRM. That decision doesn't
        │       change with scale; it changes with the cost model,
        │       which is the project. Defend, don't regret. (→ Ch. 3)
        │
        ├─► IF THEY PUSH "would you add a backend now?"
        │     → Only if the data stopped being static — user accounts,
        │       saved routes, shared coverage updates. That's the
        │       boundary where the answer flips. Not before. (→ Ch. 3)
        │
        ├─► IF THEY PUSH "what's the single highest-leverage change?"
        │     → Validate the graph on load. Cheap, closes a real trust
        │       boundary, the one place bad data crosses unchecked.
        │
        └─► IF THEY PUSH "why didn't you do these already?"
              → Honest: scope and time. The validation and the provider
                seam are hardening, not capability. I prioritized getting
                the engine and the directional cost correct first. That
                ordering was deliberate.
```

The "why didn't you do these already" branch is a real probe — own it
plainly. "I prioritized correctness of the core engine over hardening the
edges, and that ordering was deliberate" is a confident answer. Don't let it
turn into an apology.

---

## When the counterfactual question hits the gap

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They push past hardening into redesign: "If you rebuilt     ║
║   this as a real product serving thousands of cities, what    ║
║   would the architecture be, and what would you do            ║
║   differently in THAT design?"                                ║
║                                                               ║
║   This walks you straight from counterfactuals into the       ║
║   distributed-systems gap. You can name the obvious moves,    ║
║   but the deep architecture of a served, multi-region         ║
║   routing system is outside what you've built.                ║
║                                                               ║
║   Say:                                                        ║
║   "At the product level the changes are clear — the graph     ║
║    moves server-side, the build pipeline becomes a scheduled  ║
║    job per region, and routing becomes a stateless API. Where ║
║    I'd be honest is the distributed design underneath:        ║
║    partitioning a country-scale graph that doesn't shard      ║
║    cleanly, caching routes, handling cross-region queries —   ║
║    that's the part I haven't built and wouldn't redesign on   ║
║    a whiteboard from scratch. What I'd do differently is       ║
║    start by studying how the established routing engines       ║
║    solved it, because those are well-trodden problems and I'd  ║
║    rather learn the known-good answer than reinvent a worse    ║
║    one. The 'what I'd do differently' there is mostly 'I'd    ║
║    go read first.'"                                           ║
║                                                               ║
║   What this signals: you can produce the product-level         ║
║   counterfactual confidently, you draw a clean line at the     ║
║   distributed-design depth, and your "do differently" is       ║
║   intellectual humility (study the known solutions) rather     ║
║   than fabricated confidence. That's the senior posture on     ║
║   a question designed to expose the opposite.                 ║
╚═══════════════════════════════════════════════════════════════╝
```

For the deeper system-design treatment — boundaries, state ownership, scale
patterns — point yourself at **`.aipe/study-system-design/`**.

```
┃ "A fabricated regret about a good decision is worse than
┃  no counterfactual at all. It tells the interviewer you
┃  don't understand your own right calls."
```

---

## What you'd change

The meta-counterfactual — the one that generalizes — is to design the
data-loading seam up front. The disconnected-components bug (Chapter 6) and
the unvalidated load (Chapter 5) are both symptoms of the same root: the
boundary where graph data enters the runtime grew organically instead of being
designed. If I started over, I'd treat that seam as a first-class interface
from day one — validated, versioned, with the tile-loading contract explicit —
and two of my three real bugs-or-gaps would simply not exist.

---

## One-page summary — read this the night before

**Core claim:** Volunteer what you'd reconsider before being asked — and
refuse to fake a regret about the decisions that were right. Knowing which is
which is the skill.

**Questions covered:**
- *"What would you do differently?"* → KEEP: hand-rolled engine, no backend,
  directional cost, BLOCKED-finite. CHANGE: validate the graph load, provider
  seam for elevation, design the data-loading boundary up front.
- *"Anything you'd harden?"* → the `loadGraph` trust boundary (loadGraph.ts:10)
  — cast-and-trust, no validation. Highest-leverage change.
- *"Switch to a paid elevation API?"* → keep the *choice* (free, build-time);
  change the *structure* (ElevationProvider seam).
- *"Rebuild it as a served product?"* → product-level changes are clear;
  distributed graph partitioning is the gap — I'd go read first.

**Pull quotes:**
- "Volunteer what you'd reconsider before being asked."
- "A fabricated regret about a good decision is worse than no counterfactual."

**What you'd change:** Design the data-loading seam up front — validated,
versioned, explicit — and two of three real gaps disappear.
