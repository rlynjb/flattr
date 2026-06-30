# Study — Testing & Correctness (flattr)

The one question this whole guide answers:

```
  how do you KNOW the router works — and keeps working after
  the next change to cost.ts, astar.ts, or the build pipeline?

  flattr's answer is unusually strong for a side project:
  it doesn't assert "the path looks reasonable." It asserts
  "A* returns the EXACT cost Dijkstra returns." That's a
  proof-shaped test, not a vibe check.
```

130 tests, 22 files, 306ms, all green (`npx vitest run`, verified 2026-06-29). The
suite is small, fast, deterministic, and — for the routing core — genuinely
load-bearing. It is also missing entire layers (zero mobile tests, no e2e). This
guide tells you both halves honestly.

## The seam that defines this topic

```
  ┌─ study-testing (HERE) ─────────────────────────────────┐
  │  DETERMINISTIC correctness.                            │
  │  "given this graph, A* cost EQUALS Dijkstra cost."     │
  │  equals-the-expected-value. Unit / property / oracle.  │
  └────────────────────────────────────────────────────────┘
  ┌─ study-ai-engineering ─────────────────────────────────┐
  │  PROBABILISTIC evaluation. "is the LLM output good     │
  │  enough / did it regress." flattr has NO LLM yet,      │
  │  so this half is empty — honestly "not yet exercised." │
  └────────────────────────────────────────────────────────┘
```

If the assertion is `toEqual` / `toBeCloseTo` against a known value, it lives here.
flattr is almost entirely on this side of the seam — which is exactly why its tests
are so strong. There is no non-determinism to wrestle. The one place the seam would
bite (an on-device AI rerun) doesn't exist yet (see `audit.md` lens 6).

## Reading order

1. **`00-overview.md`** — the coverage map in one diagram: what's tested, what isn't,
   ranked by risk. Start here.
2. **`audit.md`** — Pass 1. The 7-lens walk. Every lens checked, `not yet exercised`
   named honestly where it applies. This is the "was everything looked at?" artifact.
3. **The pattern files** — Pass 2. Five testing *techniques* flattr applies
   deliberately, each one a transferable skill, each with a full teach-through:

   - **`01-optimality-oracle.md`** — the gold gate. A* cost must EQUAL Dijkstra cost.
     The single most important test in the repo.
   - **`02-property-invariant-tests.md`** — the heap invariant holds after 2000 random
     ops; pop order matches a sorted oracle across 50 seeds. Catches bugs example
     tests miss.
   - **`03-injected-fetch-isolation.md`** — every network test passes a mock `fetch`.
     Zero real sockets, `delayMs: 0`, a full retry matrix (400/504/429) with no flake.
   - **`04-fixture-driven-graph-tests.md`** — hand-built diamond / grade / directional
     graphs with *known* answers, so every assertion has a closed-form expected value.
   - **`05-finite-blocked-sentinel-tests.md`** — `BLOCKED = 1e9`, not `Infinity`, so
     "steep route, flagged" stays testably distinct from "no route, null." A whole
     class of test exists only because of this one design choice.

## Cross-links to sibling guides

- **`study-software-design`** — "hard to test" is a design smell. flattr's testability
  is *earned* by deep modules: `PQueue` knows nothing about graphs, `CostFn` is a
  plain function. That's a design finding; this guide references it, doesn't re-audit it.
- **`study-dsa-foundations`** — the optimality oracle and heap-invariant property test
  are testing techniques *for* the A*/Dijkstra/binary-heap fundamentals that guide teaches.
- **`study-networking`** — the injected-fetch isolation pattern is how flattr tests
  retry/timeout/backoff (the 400/504/429 matrix) without a network.
- **`study-ai-engineering`** — owns the empty half of the determinism seam: when flattr
  grows an LLM or on-device rerun, the eval harness lives there, the deterministic
  wrapper-test lives here.
- **`study-performance-engineering`** — `bench/` is measurement, not assertion. The line
  between a benchmark and a test is drawn in `audit.md` lens 1.
- **`study-system-design`** / **`study-debugging-observability`** — the build pipeline
  (`pipeline/`) and its testable seams.
