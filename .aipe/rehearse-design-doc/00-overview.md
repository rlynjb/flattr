# Design docs — flattr

These are the decisions in flattr that were **significant and non-obvious** enough to
write down. Not "we used Vitest" — nobody asks why. The three below are the ones a
skeptical reviewer stops on and asks *"why this way?"*, where a real alternative was on
the table, and where the choice is hard to walk back once shipped.

This book is the **written** layer of the rehearse family. The `study-*` guides exist so
you *understand* flattr; the interview-defense and demo books prep you to *speak* it.
These docs prep you to **align a room in writing** — the staff bottleneck is rarely the
code, it's getting the decision down on paper so reviewers nod instead of relitigating.

```
  What each rehearse book trains

  study-*                  UNDERSTAND the codebase   (for you)
  rehearse-interview-defense   DEFEND it out loud    (spoken)
  rehearse-hackathon-demo      SHOW it running       (spoken)
  rehearse-design-doc      COMMUNICATE in WRITING    (this book)  ◄── here
```

═════════════════════════════════════════════════
WHICH DECISIONS WARRANTED A DOC — ranked
═════════════════════════════════════════════════

Every decision in flattr ranked against the bar: hard to reverse, real alternative
existed, cross-cutting, someone asks "why this way?" The top three clear it. Everything
below the line is a default nobody would challenge — those don't get a doc, they get a
sentence.

```
  Decision                              reverse?   alt?    cross-cut?  → doc?
  ─────────────────────────────────────────────────────────────────────────
  build-time graph artifact, no DB      HARD       OSRM/   the whole   ★ 01
    (static graph.json read at runtime)            spatial  data layer
                                                   DB
  parametric directional router         HARD       OSRM/   every       ★ 02
    one search() = Dijkstra/A*/grade/              Valhalla route +
    directed via (costFn, heuristicFn)            engine   benchmark
  honest degradation under a throttled  HARD       fail-   routing +   ★ 03
    free elevation API                            build /  heatmap +
    (marked-degraded, not silent-flat)            fake-flat cache
  ─────────────────────────────────────────────────────────────────────────
  Vitest for tests                      easy       jest     local      no
  TypeScript strict ESM                 easy       —        —          no
  hand-rolled binary heap (pqueue.ts)   easy       npm lib  local      no †
```

† The hand-rolled heap is a deliberate *portfolio* choice (the DSA work is the point of
the project, per `docs/flattr-spec.md` §14), but it isn't a hard-to-reverse architecture
decision — swap in `npm i tinyqueue` and nothing else moves. It's a craft choice, not an
RFC. It shows up *inside* doc 02 as the substitution seam, where it belongs.

**The three that earned a doc:**

1. **[01 — Build-time graph artifact, no database](01-build-time-graph-artifact.md)**
   The graph is a prebuilt static `graph.json` the app only reads (`mobile/src/loadGraph.ts`,
   `pipeline/build-graph.ts`). No backend, no spatial DB, no schema migrations. The
   alternative was a routing server fronting PostGIS. The access pattern — read-only
   whole-graph traversal where adjacency *is* the index — is what makes a database the
   wrong tool here, and what makes "frozen data" the cost you accept.

2. **[02 — Parametric directional router](02-parametric-directional-router.md)**
   One `search()` function *is* Dijkstra, A*, grade-aware A*, and directional A* — the
   stage is just a `(costFn, heuristicFn)` pair (`features/routing/astar.ts`). Direction
   is real: A→B costs differently than B→A because `directedGrade` flips sign
   (`features/routing/graph.ts:17`, `features/routing/cost.ts:32`). `BLOCKED` is
   `1e9`, finite, not `Infinity` (`cost.ts:5`) — that one constant is load-bearing.

3. **[03 — Honest degradation under a throttled elevation API](03-honest-degradation.md)**
   The free Open-Meteo elevation API 429s under load. The build degrades to flat (0 m)
   elevation marked `degraded` rather than failing or silently faking flat
   (`mobile/src/useTileGraph.ts:20`). Degraded regions route fine but are *excluded from
   the heatmap* so bogus all-green doesn't paint over real grades (`useTileGraph.ts:150`).
   A capped self-heal retry and a persistent AsyncStorage cache back it
   (`useTileGraph.ts:209`, `mobile/src/elevCache.ts`). The all-green masking bug is what
   forced the marked-degraded split.

═════════════════════════════════════════════════
THE DOC TEMPLATE — every doc, same spine
═════════════════════════════════════════════════

One doc = one decision. Each follows the canonical RFC shape so a reviewer always knows
where to find the part they care about:

```
  1. Title + one-line summary    the decision in a sentence, up top
  2. Context / problem           what forced it — real repo constraints
  3. Goals & non-goals           what it must do; what it explicitly won't
  4. The decision                the chosen design + a mandatory diagram
  5. Alternatives considered     2-3 real options, each with why it lost
  6. Tradeoffs accepted          the cost, owned without flinching
  7. Risks & mitigations         what breaks, what guards it
  8. Rollout / migration         how it ships; what changes for callers/data
  9. Open questions              what's still undecided (honesty = staff signal)
```

**Coach notes** thread through each doc — flagged inline as `> Coach:`. They mark where a
reviewer will push and the framing that holds. The pattern is "say this, not that": lead
with the decision, name the tradeoff in the same breath as the benefit, never apologize
for a deliberate choice.

═════════════════════════════════════════════════
HOW TO USE THESE
═════════════════════════════════════════════════

- **Before a design review** — paste the relevant doc, let people read, then discuss. The
  doc does the alignment; the meeting handles the disagreement.
- **In an interview** — when asked "walk me through a hard decision," these are three,
  pre-argued, with the alternative and the tradeoff already named.
- **In a promo packet** — "I made these calls and wrote them up" is the staff artifact.
- **As reusable templates** — the spine in any doc transfers to the next decision you
  make. Copy the shape, swap the content.

Each doc is grounded in real files and line numbers in this repo. No invented decisions.

**Cross-links to the study guides** (the comprehension layer underneath these docs):
- `study-system-design/01-build-time-graph-artifact.md`,
  `study-system-design/04-honest-fallback-routing.md`,
  `study-system-design/05-elevation-provider-fallback.md`
- `study-dsa-foundations/05-graphs-and-traversals.md`,
  `study-dsa-foundations/03-stacks-queues-deques-and-heaps.md`
- `study-performance-engineering/`, `study-distributed-systems/`, `study-networking/`
