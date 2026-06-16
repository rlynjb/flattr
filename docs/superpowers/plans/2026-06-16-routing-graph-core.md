# Routing Graph Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build flatr's hand-rolled, grade-aware routing engine — a generic binary-heap priority queue and a single parametric search engine that progresses Dijkstra → A* → grade-cost A* → directional A* → bidirectional A*, plus a benchmark harness that proves each refinement, all on hand-built fixtures with no external data.

**Architecture:** One generic `PQueue<T>` (lazy-deletion min-heap). One `search()` engine parameterized by a cost function and a heuristic function; the §15.2 stages are just different (cost, heuristic) pairs through that one engine, so correctness and metrics are shared. Direction is derived at traversal time (`directedGrade`), not materialized. Bidirectional A* is a separate engine using a balanced consistent potential. A synthetic grid-graph generator gives the benchmark enough nodes to show A* pruning vs Dijkstra.

**Tech Stack:** TypeScript (strict), Vitest (test + property tests), tsx (run the benchmark). No third-party heap, graph, or routing library.

> **⚠️ Tech-stack revisit (Android).** The spec (§8) targets a **web** app
> (Next.js + React + MapLibre GL JS on Netlify). A native **Android** target is
> under consideration but NOT decided. This does not affect Plan 1: the routing
> graph core is platform-agnostic pure TypeScript with no UI/framework
> dependency, so it stands regardless. Revisit the platform decision before
> Plan 3 (the map app) — see `ROADMAP.md`. If Android wins, the engine here is
> reusable via a TS runtime (React Native / Capacitor) or as the reference for a
> Kotlin port; the algorithms and tests don't change.

**Source specs:** `docs/flattr-spec.md` (§4, §4.1, §6, §7, §14, §15) and `docs/flattr-pqueue-spec.md`. Build order and locked decisions: `docs/superpowers/plans/ROADMAP.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project scaffold |
| `lib/geo.ts` | `haversine(a, b)` — straight-line meters (the heuristic) |
| `features/routing/types.ts` | `Node`, `Edge`, `Graph`, `Path`, `CostFn`, `HeuristicFn`, `SearchResult` |
| `features/routing/pqueue.ts` | Generic lazy-deletion binary min-heap |
| `features/routing/graph.ts` | `edgeById`, `otherEnd`, `directedGrade`, `buildAdjacency` |
| `features/routing/cost.ts` | `BLOCKED`, `penalty`, `distanceCost`, `gradeCostAbs`, `gradeCostDirected` |
| `features/routing/astar.ts` | `search()` engine + `summarizePath` + `dijkstra`/`astar`/`gradeAstar`/`directedAstar` + heuristics |
| `features/routing/bidirectional.ts` | Bidirectional A* with balanced potential |
| `features/routing/fixtures.ts` | Hand-built named graphs + `makeGridGraph` generator, shared by tests and bench |
| `bench/run.ts`, `bench/report.ts` | Run each algorithm over fixed pairs, print the comparison table |

Test files are co-located: `features/routing/pqueue.test.ts`, etc.

Build order is strict dependency order: scaffold → geo → types → pqueue → graph → cost → search engine (Dijkstra) → A* → grade → directional → honesty → bidirectional → fixtures → bench. Each task is independently testable and committed.

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "flatr",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "bench": "tsx bench/run.ts"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

(`@types/node` is required by Task 12's `bench/run.ts`, which imports
`node:perf_hooks`. Added here so the scaffold typechecks once bench lands.)

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["vitest/globals", "node"],
    "noEmit": true
  },
  "include": ["features", "lib", "bench"]
}
```

Note: we use `strict` but deliberately NOT `noUncheckedIndexedAccess` — the code below indexes `graph.nodes[id]` directly and guards missing edges explicitly in `edgeById`. Keep it this way so the code in this plan compiles as written.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors; `package-lock.json` written.

- [ ] **Step 6: Verify the toolchain runs with an empty suite**

Run: `npm test`
Expected: Vitest reports "No test files found" (exit 0) — toolchain works.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold TypeScript + Vitest project"
```

---

## Task 1: `lib/geo.ts` — haversine distance

**Files:**
- Create: `lib/geo.ts`
- Test: `lib/geo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/geo.test.ts
import { describe, it, expect } from "vitest";
import { haversine } from "./geo";

describe("haversine", () => {
  it("returns 0 for the same point", () => {
    expect(haversine({ lat: 47.61, lng: -122.33 }, { lat: 47.61, lng: -122.33 })).toBe(0);
  });

  it("matches a known distance within 0.5%", () => {
    // ~1 deg of latitude ~= 111.19 km at the equator
    const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("is symmetric", () => {
    const a = { lat: 47.61, lng: -122.33 };
    const b = { lat: 47.62, lng: -122.34 };
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/geo.test.ts`
Expected: FAIL — cannot find module `./geo`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/geo.ts
export type LatLng = { lat: number; lng: number };

const R = 6_371_008.8; // mean Earth radius, meters (IUGG)

/** Great-circle distance between two lat/lng points, in meters. */
export function haversine(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/geo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/geo.ts lib/geo.test.ts
git commit -m "feat: add haversine distance"
```

---

## Task 2: `features/routing/types.ts` — domain types

**Files:**
- Create: `features/routing/types.ts`

Type-only module; verified by `tsc`, no unit test.

- [ ] **Step 1: Write the types**

```ts
// features/routing/types.ts
export type Node = {
  id: string;
  lat: number;
  lng: number;
  elevationM: number;
};

export type EdgeKind = "sidewalk" | "footway" | "residential" | "path" | "crossing";

export type Edge = {
  id: string;
  fromNode: string;
  toNode: string;
  geometry: [number, number][]; // [lat, lng] polyline
  lengthM: number;
  riseM: number; // signed, from -> to
  gradePct: number; // signed, from -> to
  absGradePct: number; // |gradePct| — steepness only
  kind?: EdgeKind;
};

export type Graph = {
  city: string;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  nodes: Record<string, Node>;
  edges: Edge[];
  adjacency: Record<string, string[]>; // nodeId -> incident edgeIds
};

/** A resolved route. cost is in routing units; lengthM is real distance. */
export type Path = {
  nodes: string[]; // start..goal, inclusive
  edges: string[]; // edgeIds, length = nodes.length - 1
  cost: number; // total routing cost (sum of costFn over edges)
  lengthM: number; // total real distance
  steepEdges: string[]; // edgeIds whose directed grade exceeds userMax (honesty)
};

/** Cost of traversing `edge` starting at `fromNodeId`, given the user's max grade. */
export type CostFn = (edge: Edge, fromNodeId: string, userMax: number) => number;

/** Admissible estimate of remaining cost from `node` to `goal`. */
export type HeuristicFn = (node: Node, goal: Node) => number;

/** A search result plus the metrics the benchmark records (§15.3). */
export type SearchResult = {
  path: Path | null;
  nodesExpanded: number; // nodes finalized (added to closed set)
  pushes: number; // total heap pushes
  pops: number; // total heap pops (incl. stale)
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add features/routing/types.ts
git commit -m "feat: add routing domain types"
```

---

## Task 3: `features/routing/pqueue.ts` — generic min-heap

Implements `docs/flattr-pqueue-spec.md`. Lazy-deletion binary min-heap. One
addition beyond the mini-spec §3 interface: `peekPriority()`, needed by the
bidirectional stopping rule in Task 11.

**Files:**
- Create: `features/routing/pqueue.ts`
- Test: `features/routing/pqueue.test.ts`

- [ ] **Step 1: Write the failing tests** (covers mini-spec §9.1–§9.6)

```ts
// features/routing/pqueue.test.ts
import { describe, it, expect } from "vitest";
import { PQueue } from "./pqueue";

// Deterministic LCG so the property tests are reproducible (no Math.random seed control needed).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("PQueue", () => {
  it("is empty on creation", () => {
    const pq = new PQueue<string>();
    expect(pq.isEmpty()).toBe(true);
    expect(pq.size).toBe(0);
    expect(pq.pop()).toBeUndefined();
    expect(pq.peek()).toBeUndefined();
    expect(pq.peekPriority()).toBeUndefined();
  });

  it("pops in non-decreasing priority order (oracle, many seeds)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = lcg(seed);
      const pq = new PQueue<number>();
      const n = 200;
      for (let i = 0; i < n; i++) pq.push(i, Math.floor(rand() * 1000));
      let prev = -Infinity;
      let count = 0;
      while (!pq.isEmpty()) {
        const before = pq.peekPriority()!;
        pq.pop();
        expect(before).toBeGreaterThanOrEqual(prev);
        prev = before;
        count++;
      }
      expect(count).toBe(n);
    }
  });

  it("matches a sorted array of the same (item, priority) pairs", () => {
    const rand = lcg(7);
    const pairs = Array.from({ length: 300 }, (_, i) => ({ item: i, p: Math.floor(rand() * 500) }));
    const pq = new PQueue<number>();
    for (const { item, p } of pairs) pq.push(item, p);
    const popped: number[] = [];
    while (!pq.isEmpty()) popped.push(pq.peekPriority()!), pq.pop();
    const sorted = [...pairs].map((x) => x.p).sort((a, b) => a - b);
    expect(popped).toEqual(sorted);
  });

  it("allows duplicate items and duplicate priorities", () => {
    const pq = new PQueue<string>();
    pq.push("a", 5);
    pq.push("a", 1);
    pq.push("b", 1);
    expect(pq.size).toBe(3);
    const p1 = pq.peekPriority();
    pq.pop();
    pq.pop();
    pq.pop();
    expect(p1).toBe(1);
    expect(pq.isEmpty()).toBe(true);
  });

  it("keeps the heap invariant after a random mix of pushes and pops", () => {
    const rand = lcg(99);
    const pq = new PQueue<number>();
    for (let step = 0; step < 2000; step++) {
      if (rand() < 0.6 || pq.isEmpty()) {
        pq.push(step, Math.floor(rand() * 1000));
      } else {
        pq.pop();
      }
      expect(pq.checkInvariant()).toBe(true);
    }
  });

  it("interleaved pushes/pops stay non-decreasing within each drain", () => {
    const rand = lcg(123);
    const pq = new PQueue<number>();
    for (let i = 0; i < 100; i++) pq.push(i, Math.floor(rand() * 100));
    // pop half
    let prev = -Infinity;
    for (let i = 0; i < 50; i++) {
      const p = pq.peekPriority()!;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
      pq.pop();
    }
    // push more (some lower than already-popped — allowed, they sort among the rest)
    for (let i = 100; i < 150; i++) pq.push(i, Math.floor(rand() * 100));
    // remaining drain is non-decreasing on its own
    prev = -Infinity;
    while (!pq.isEmpty()) {
      const p = pq.peekPriority()!;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
      pq.pop();
    }
  });

  it("orders a large-finite BLOCKED priority to the back", () => {
    const pq = new PQueue<string>();
    pq.push("blocked", 1e9);
    pq.push("ok", 10);
    expect(pq.peek()).toBe("ok");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run features/routing/pqueue.test.ts`
Expected: FAIL — cannot find module `./pqueue`.

- [ ] **Step 3: Write the implementation**

```ts
// features/routing/pqueue.ts — generic lazy-deletion binary min-heap.
// Knows nothing about graphs/grades; it orders items by a number (mini-spec §1).
type Entry<T> = { item: T; priority: number };

export class PQueue<T> {
  private heap: Entry<T>[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  peek(): T | undefined {
    return this.heap.length === 0 ? undefined : this.heap[0].item;
  }

  peekPriority(): number | undefined {
    return this.heap.length === 0 ? undefined : this.heap[0].priority;
  }

  push(item: T, priority: number): void {
    if (Number.isNaN(priority)) throw new Error("PQueue: NaN priority forbidden");
    this.heap.push({ item, priority });
    this.siftUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    const n = this.heap.length;
    if (n === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (n > 1) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top.item;
  }

  /** Test-only: assert priority[parent] <= priority[child] across the array. */
  checkInvariant(): boolean {
    for (let i = 1; i < this.heap.length; i++) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].priority > this.heap[i].priority) return false;
    }
    return true;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].priority <= this.heap[i].priority) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = tmp;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run features/routing/pqueue.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/pqueue.ts features/routing/pqueue.test.ts
git commit -m "feat: add generic lazy-deletion binary min-heap PQueue"
```

---

## Task 4: `features/routing/graph.ts` — adjacency + directed traversal

**Files:**
- Create: `features/routing/graph.ts`
- Test: `features/routing/graph.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// features/routing/graph.test.ts
import { describe, it, expect } from "vitest";
import { edgeById, otherEnd, directedGrade, buildAdjacency } from "./graph";
import type { Edge, Graph } from "./types";

const edge: Edge = {
  id: "e1",
  fromNode: "A",
  toNode: "B",
  geometry: [
    [0, 0],
    [0, 1],
  ],
  lengthM: 100,
  riseM: 8,
  gradePct: 8,
  absGradePct: 8,
};

function graphWith(edges: Edge[]): Graph {
  return {
    city: "test",
    bbox: [0, 0, 1, 1],
    nodes: {},
    edges,
    adjacency: buildAdjacency(edges),
  };
}

describe("graph helpers", () => {
  it("edgeById returns the edge", () => {
    const g = graphWith([edge]);
    expect(edgeById(g, "e1")).toBe(edge);
  });

  it("edgeById throws on a missing id", () => {
    const g = graphWith([edge]);
    expect(() => edgeById(g, "nope")).toThrow(/nope/);
  });

  it("otherEnd returns the opposite node", () => {
    expect(otherEnd(edge, "A")).toBe("B");
    expect(otherEnd(edge, "B")).toBe("A");
  });

  it("otherEnd throws if the node is not an endpoint", () => {
    expect(() => otherEnd(edge, "Z")).toThrow();
  });

  it("directedGrade is +grade forward, -grade reverse (§4.1)", () => {
    expect(directedGrade(edge, "A")).toBe(8);
    expect(directedGrade(edge, "B")).toBe(-8);
  });

  it("buildAdjacency lists every incident edge for both endpoints", () => {
    const e2: Edge = { ...edge, id: "e2", fromNode: "B", toNode: "C" };
    const adj = buildAdjacency([edge, e2]);
    expect(adj["A"]).toEqual(["e1"]);
    expect(adj["B"].sort()).toEqual(["e1", "e2"]);
    expect(adj["C"]).toEqual(["e2"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run features/routing/graph.test.ts`
Expected: FAIL — cannot find module `./graph`.

- [ ] **Step 3: Write the implementation**

```ts
// features/routing/graph.ts — adjacency + direction-aware traversal over
// undirected storage (spec §4.1, decision §11.F: derive direction, don't materialize).
import type { Edge, Graph } from "./types";

export function edgeById(graph: Graph, edgeId: string): Edge {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) throw new Error(`edgeById: no edge with id "${edgeId}"`);
  return edge;
}

/** The endpoint of `edge` opposite `nodeId`. */
export function otherEnd(edge: Edge, nodeId: string): string {
  if (nodeId === edge.fromNode) return edge.toNode;
  if (nodeId === edge.toNode) return edge.fromNode;
  throw new Error(`otherEnd: "${nodeId}" is not an endpoint of edge "${edge.id}"`);
}

/** Signed grade in the direction of travel: +gradePct forward, -gradePct reverse. */
export function directedGrade(edge: Edge, fromNodeId: string): number {
  return fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct;
}

/** Map each node id to the ids of edges incident to it. */
export function buildAdjacency(edges: Edge[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) {
    (adj[e.fromNode] ??= []).push(e.id);
    (adj[e.toNode] ??= []).push(e.id);
  }
  return adj;
}
```

Note: `edgeById` uses a linear `find` for clarity. The benchmark graphs are small; if a future profile shows it matters, swap to a `Map<string, Edge>` built once on the graph. Parked, not premature.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run features/routing/graph.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/graph.ts features/routing/graph.test.ts
git commit -m "feat: add graph adjacency and directed traversal helpers"
```

---

## Task 5: `features/routing/cost.ts` — grade penalty + cost functions

Implements spec §6 `penalty` and the three cost functions the search engine
plugs in (distance, abs-grade, directed-grade).

**Files:**
- Create: `features/routing/cost.ts`
- Test: `features/routing/cost.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// features/routing/cost.test.ts
import { describe, it, expect } from "vitest";
import {
  BLOCKED,
  penalty,
  distanceCost,
  gradeCostAbs,
  gradeCostDirected,
  DEFAULT_K1,
  DEFAULT_K2,
} from "./cost";
import type { Edge } from "./types";

const max = 5;

function edgeAt(gradePct: number): Edge {
  return {
    id: "e",
    fromNode: "A",
    toNode: "B",
    geometry: [
      [0, 0],
      [0, 1],
    ],
    lengthM: 100,
    riseM: gradePct,
    gradePct,
    absGradePct: Math.abs(gradePct),
  };
}

describe("penalty (spec §6)", () => {
  it("is 0 for downhill or flat", () => {
    expect(penalty(0, max)).toBe(0);
    expect(penalty(-3, max)).toBe(0);
  });

  it("is linear in the moderate band (g <= 0.5*max)", () => {
    expect(penalty(2, max)).toBeCloseTo(DEFAULT_K1 * 2, 10);
  });

  it("is continuous at the moderate/steep boundary (0.5*max)", () => {
    const half = 0.5 * max;
    const linearAtBoundary = DEFAULT_K1 * half;
    expect(penalty(half, max)).toBeCloseTo(linearAtBoundary, 10);
  });

  it("is quadratic in the steep band and larger than the linear extrapolation", () => {
    const g = 4; // between 0.5*max (2.5) and max (5)
    const half = 0.5 * max;
    const expected = DEFAULT_K2 * (g - half) ** 2 + DEFAULT_K1 * half;
    expect(penalty(g, max)).toBeCloseTo(expected, 10);
    expect(penalty(g, max)).toBeGreaterThan(DEFAULT_K1 * g); // steeper than linear
  });

  it("returns BLOCKED above max", () => {
    expect(penalty(5.01, max)).toBe(BLOCKED);
    expect(penalty(20, max)).toBe(BLOCKED);
  });
});

describe("cost functions", () => {
  it("distanceCost ignores grade and returns lengthM", () => {
    expect(distanceCost(edgeAt(12), "A", max)).toBe(100);
  });

  it("gradeCostAbs penalizes by steepness regardless of direction", () => {
    const up = gradeCostAbs(edgeAt(4), "A", max);
    const down = gradeCostAbs(edgeAt(-4), "A", max);
    expect(up).toBe(down); // |grade| identical
    expect(up).toBeGreaterThan(100);
  });

  it("gradeCostDirected is free downhill, penalized uphill (§4.1)", () => {
    const e = edgeAt(4); // 4% climb A->B
    const uphill = gradeCostDirected(e, "A", max); // forward = +4 climb
    const downhill = gradeCostDirected(e, "B", max); // reverse = -4 descent
    expect(downhill).toBe(100); // free
    expect(uphill).toBeGreaterThan(100);
  });

  it("gradeCostDirected blocks a too-steep climb but stays finite", () => {
    const e = edgeAt(9); // climbs 9% A->B, exceeds max 5
    const c = gradeCostDirected(e, "A", max);
    expect(c).toBeGreaterThan(BLOCKED); // lengthM * (1 + BLOCKED)
    expect(Number.isFinite(c)).toBe(true);
  });
});

it("exports the default tuning constants", () => {
  expect(DEFAULT_K1).toBeGreaterThan(0);
  expect(DEFAULT_K2).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run features/routing/cost.test.ts`
Expected: FAIL — cannot find module `./cost`.

- [ ] **Step 3: Write the implementation**

```ts
// features/routing/cost.ts — domain cost: the signed directed-grade penalty (spec §6).
import type { CostFn } from "./types";
import { directedGrade } from "./graph";

/** Large but FINITE, so an only-steep path is still returned and flagged (spec §6, §14.4). */
export const BLOCKED = 1e9;

// Tunable (spec §6). k1 scales the moderate band; k2 the quadratic steep band.
export const DEFAULT_K1 = 0.4;
export const DEFAULT_K2 = 1.0;

/**
 * Penalty multiplier for a SIGNED directed grade `g` (percent) against `max` (percent).
 * downhill/flat -> 0 | moderate uphill -> linear | steep uphill -> quadratic | over max -> BLOCKED.
 * Continuous at the 0.5*max boundary by construction.
 */
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;
  if (g > max) return BLOCKED;
  const half = 0.5 * max;
  if (g <= half) return k1 * g;
  return k2 * (g - half) ** 2 + k1 * half;
}

/** Pure distance — Dijkstra/A* baseline (stages 1–2). */
export const distanceCost: CostFn = (edge) => edge.lengthM;

/** Undirected steepness penalty (stage 3) — symmetric, A->B == B->A. */
export const gradeCostAbs: CostFn = (edge, _fromNodeId, userMax) =>
  edge.lengthM * (1 + penalty(edge.absGradePct, userMax));

/** Directional penalty (stage 4) — free downhill, penalized uphill (§4.1). */
export const gradeCostDirected: CostFn = (edge, fromNodeId, userMax) =>
  edge.lengthM * (1 + penalty(directedGrade(edge, fromNodeId), userMax));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run features/routing/cost.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/cost.ts features/routing/cost.test.ts
git commit -m "feat: add grade penalty and cost functions"
```

---

## Task 6: `features/routing/fixtures.ts` — hand-built graphs

The §9.7 correctness baseline (a 6-node hand-built graph with known shortest
paths) plus grade/directional fixtures and a grid generator for the benchmark.
Shared by tests and `bench/`.

**Files:**
- Create: `features/routing/fixtures.ts`
- Test: `features/routing/fixtures.test.ts`

- [ ] **Step 1: Write the failing tests** (sanity-check the fixtures themselves)

```ts
// features/routing/fixtures.test.ts
import { describe, it, expect } from "vitest";
import { diamondGraph, gradeGraph, directionalGraph, makeGridGraph } from "./fixtures";

describe("fixtures", () => {
  it("diamondGraph has 6 nodes and a connected adjacency", () => {
    const g = diamondGraph();
    expect(Object.keys(g.nodes).length).toBe(6);
    for (const id of Object.keys(g.nodes)) {
      expect((g.adjacency[id] ?? []).length).toBeGreaterThan(0);
    }
  });

  it("gradeGraph offers a flat-but-long and a steep-but-short route", () => {
    const g = gradeGraph();
    expect(g.nodes["S"]).toBeDefined();
    expect(g.nodes["G"]).toBeDefined();
  });

  it("makeGridGraph builds an n*n lattice with 4-neighbor adjacency", () => {
    const g = makeGridGraph(5);
    expect(Object.keys(g.nodes).length).toBe(25);
    // a corner has 2 neighbors, an interior node has 4
    expect(g.adjacency["0,0"].length).toBe(2);
    expect(g.adjacency["2,2"].length).toBe(4);
  });

  it("every edge's absGradePct equals |gradePct|", () => {
    for (const g of [diamondGraph(), gradeGraph(), directionalGraph(), makeGridGraph(4)]) {
      for (const e of g.edges) expect(e.absGradePct).toBeCloseTo(Math.abs(e.gradePct), 9);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run features/routing/fixtures.test.ts`
Expected: FAIL — cannot find module `./fixtures`.

- [ ] **Step 3: Write the implementation**

```ts
// features/routing/fixtures.ts — hand-built graphs for tests + benchmark.
import type { Edge, Graph, Node } from "./types";
import { buildAdjacency } from "./graph";

function node(id: string, lat: number, lng: number, elevationM: number): Node {
  return { id, lat, lng, elevationM };
}

/** Build an undirected edge between two nodes; derives length/rise/grade from the nodes. */
function edge(id: string, from: Node, to: Node, lengthM: number): Edge {
  const riseM = to.elevationM - from.elevationM;
  const gradePct = (riseM / lengthM) * 100;
  return {
    id,
    fromNode: from.id,
    toNode: to.id,
    geometry: [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ],
    lengthM,
    riseM,
    gradePct,
    absGradePct: Math.abs(gradePct),
  };
}

function assemble(city: string, nodes: Node[], edges: Edge[]): Graph {
  const nodeMap: Record<string, Node> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  const lats = nodes.map((n) => n.lat);
  const lngs = nodes.map((n) => n.lng);
  return {
    city,
    bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    nodes: nodeMap,
    edges,
    adjacency: buildAdjacency(edges),
  };
}

/**
 * 6-node graph with a known shortest path by distance (mini-spec §9.7 baseline).
 * Flat (all elevation 0) so distance == the only cost.
 *   S -100- A -100- G     (top path, total 200)
 *   S -100- B -150- G     (bottom path, total 250)
 *   A -100- C -100- B     (detour)
 *   S ----- D ----- G     (D is a far dead-ish branch, 300 + 300)
 * Known: shortest S->G = S,A,G (200).
 */
export function diamondGraph(): Graph {
  const S = node("S", 0, 0, 0);
  const A = node("A", 0.001, 0.001, 0);
  const B = node("B", -0.001, 0.001, 0);
  const G = node("G", 0, 0.002, 0);
  const C = node("C", 0, 0.0015, 0);
  const D = node("D", 0.003, 0.001, 0);
  const nodes = [S, A, B, G, C, D];
  const edges = [
    edge("sa", S, A, 100),
    edge("ag", A, G, 100),
    edge("sb", S, B, 100),
    edge("bg", B, G, 150),
    edge("ac", A, C, 100),
    edge("cb", C, B, 100),
    edge("sd", S, D, 300),
    edge("dg", D, G, 300),
  ];
  return assemble("diamond", nodes, edges);
}

/**
 * Flat-vs-steep choice (stage 3). Elevations make the SHORT path steep and the
 * LONG path flat, so the grade router should prefer the longer-but-flat route.
 *   S -100- H -100- G    via H: short, but H is high (steep climbs)
 *   S -160- L -160- G    via L: longer, but flat (all near 0 elevation)
 */
export function gradeGraph(): Graph {
  const S = node("S", 0, 0, 0);
  const H = node("H", 0.001, 0.0005, 9); // +9m over 100m = 9% climb in, 9% drop out
  const L = node("L", -0.001, 0.001, 0);
  const G = node("G", 0, 0.002, 0);
  const nodes = [S, H, L, G];
  const edges = [
    edge("sh", S, H, 100), // 9% up
    edge("hg", H, G, 100), // 9% down
    edge("sl", S, L, 160), // flat
    edge("lg", L, G, 160), // flat
  ];
  return assemble("grade", nodes, edges);
}

/**
 * Directional asymmetry (stage 4). A single steep edge X->Y climbs one way.
 * Going X->Y should detour; going Y->X (downhill) should take the direct edge.
 *   X --steep-- Y   (direct, climbs 8% X->Y)
 *   X - F - Y       (flat detour, longer)
 */
export function directionalGraph(): Graph {
  const X = node("X", 0, 0, 0);
  const Y = node("Y", 0, 0.001, 8); // +8m over 100m = 8% climb X->Y
  const F = node("F", 0.0008, 0.0005, 0); // flat detour node
  const nodes = [X, Y, F];
  const edges = [
    edge("xy", X, Y, 100), // direct, 8% climb X->Y / 8% descent Y->X
    edge("xf", X, F, 90), // flat
    edge("fy", F, Y, 90), // flat (Y is +8 but over... keep flat-ish)
  ];
  // Force the detour edges flat regardless of Y's elevation, so only "xy" is steep.
  edges[1] = { ...edges[1], riseM: 0, gradePct: 0, absGradePct: 0 };
  edges[2] = { ...edges[2], riseM: 0, gradePct: 0, absGradePct: 0 };
  return assemble("directional", nodes, edges);
}

/**
 * n*n lattice for the benchmark — enough nodes to show A* pruning vs Dijkstra's
 * flood. Node ids are "row,col". Elevation is a smooth ramp + a ridge so grades
 * vary. Edge length is a fixed ~80m grid spacing.
 */
export function makeGridGraph(n: number): Graph {
  const spacingM = 80;
  const nodes: Node[] = [];
  const id = (r: number, c: number) => `${r},${c}`;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // smooth ramp east + a ridge down the middle column -> nontrivial grades
      const elevationM = c * 3 + Math.max(0, 6 - Math.abs(c - (n - 1) / 2)) * 2;
      // ~0.00072 deg lat per 80m; lng scaled so haversine stays sane near equator
      nodes.push(node(id(r, c), r * 0.00072, c * 0.00072, elevationM));
    }
  }
  const nodeMap: Record<string, Node> = {};
  for (const nd of nodes) nodeMap[nd.id] = nd;
  const edges: Edge[] = [];
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (c + 1 < n) edges.push(edge(`e${k++}`, nodeMap[id(r, c)], nodeMap[id(r, c + 1)], spacingM));
      if (r + 1 < n) edges.push(edge(`e${k++}`, nodeMap[id(r, c)], nodeMap[id(r + 1, c)], spacingM));
    }
  }
  return assemble(`grid${n}`, nodes, edges);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run features/routing/fixtures.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/fixtures.ts features/routing/fixtures.test.ts
git commit -m "feat: add hand-built graph fixtures and grid generator"
```

---

## Task 7: `features/routing/astar.ts` — search engine + Dijkstra (stage 1)

The one parametric engine (cost + heuristic) per `pqueue-spec.md` §5. This task
adds the engine, `summarizePath`, the heuristics, and the `dijkstra` wrapper, and
proves correctness against the §9.7 baseline.

**Files:**
- Create: `features/routing/astar.ts`
- Test: `features/routing/astar.test.ts`

- [ ] **Step 1: Write the failing tests (Dijkstra / stage 1)**

```ts
// features/routing/astar.test.ts
import { describe, it, expect } from "vitest";
import { dijkstra } from "./astar";
import { diamondGraph } from "./fixtures";

describe("dijkstra (stage 1, correctness baseline)", () => {
  it("finds the known shortest path S->G in the diamond graph", () => {
    const r = dijkstra(diamondGraph(), "S", "G");
    expect(r.path).not.toBeNull();
    expect(r.path!.nodes).toEqual(["S", "A", "G"]);
    expect(r.path!.lengthM).toBe(200);
    expect(r.path!.cost).toBe(200);
  });

  it("returns a trivial path when start === goal", () => {
    const r = dijkstra(diamondGraph(), "S", "S");
    expect(r.path!.nodes).toEqual(["S"]);
    expect(r.path!.edges).toEqual([]);
    expect(r.path!.cost).toBe(0);
  });

  it("returns null when goal is unreachable", () => {
    const g = diamondGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];
    const r = dijkstra(g, "S", "ISO");
    expect(r.path).toBeNull();
  });

  it("records metrics (expanded/pushes/pops)", () => {
    const r = dijkstra(diamondGraph(), "S", "G");
    expect(r.nodesExpanded).toBeGreaterThan(0);
    expect(r.pushes).toBeGreaterThan(0);
    expect(r.pops).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run features/routing/astar.test.ts`
Expected: FAIL — cannot find module `./astar`.

- [ ] **Step 3: Write the implementation**

```ts
// features/routing/astar.ts — one parametric search engine (pqueue-spec §5).
// The §15.2 stages are just (costFn, heuristicFn) choices through this engine.
import type { CostFn, Edge, Graph, HeuristicFn, Node, Path, SearchResult } from "./types";
import { PQueue } from "./pqueue";
import { edgeById, otherEnd, directedGrade } from "./graph";
import { haversine } from "../../lib/geo";
import { distanceCost, gradeCostAbs, gradeCostDirected } from "./cost";

export const zeroHeuristic: HeuristicFn = () => 0;
export const haversineHeuristic: HeuristicFn = (node, goal) => haversine(node, goal);

/**
 * Generic grade-aware search with lazy-deletion + closed set (pqueue-spec §5).
 * Returns the optimal path for the given cost/heuristic, plus search metrics.
 */
export function search(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number,
  costFn: CostFn,
  heuristicFn: HeuristicFn
): SearchResult {
  const open = new PQueue<string>();
  const g = new Map<string, number>();
  const came = new Map<string, { edge: Edge; prev: string }>();
  const closed = new Set<string>();
  let pushes = 0;
  let pops = 0;
  let nodesExpanded = 0;

  const goal = graph.nodes[goalId];
  if (!graph.nodes[startId] || !goal) {
    return { path: null, nodesExpanded, pushes, pops };
  }

  g.set(startId, 0);
  open.push(startId, heuristicFn(graph.nodes[startId], goal));
  pushes++;

  while (!open.isEmpty()) {
    const current = open.pop()!;
    pops++;
    if (closed.has(current)) continue; // stale duplicate (lazy deletion)
    if (current === goalId) {
      return {
        path: summarizePath(graph, reconstructNodes(came, startId, goalId), userMax, costFn),
        nodesExpanded,
        pushes,
        pops,
      };
    }
    closed.add(current);
    nodesExpanded++;

    for (const edgeId of graph.adjacency[current] ?? []) {
      const edge = edgeById(graph, edgeId);
      const next = otherEnd(edge, current);
      if (closed.has(next)) continue;
      const tentative = g.get(current)! + costFn(edge, current, userMax);
      if (tentative < (g.get(next) ?? Infinity)) {
        g.set(next, tentative);
        came.set(next, { edge, prev: current });
        open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
        pushes++;
      }
    }
  }
  return { path: null, nodesExpanded, pushes, pops };
}

/** Walk came-from from goal back to start, returning the node id sequence. */
function reconstructNodes(
  came: Map<string, { edge: Edge; prev: string }>,
  startId: string,
  goalId: string
): string[] {
  const nodes: string[] = [goalId];
  let cur = goalId;
  while (cur !== startId) {
    const entry = came.get(cur)!;
    cur = entry.prev;
    nodes.push(cur);
  }
  nodes.reverse();
  return nodes;
}

/**
 * Turn a node sequence into a Path: resolve edges between consecutive nodes,
 * total cost + length, and flag edges whose DIRECTED grade exceeds userMax (§14.4).
 * Shared by `search` and `bidirectional` so both summarize identically.
 */
export function summarizePath(
  graph: Graph,
  nodeSeq: string[],
  userMax: number,
  costFn: CostFn
): Path {
  const edges: string[] = [];
  const steepEdges: string[] = [];
  let cost = 0;
  let lengthM = 0;
  for (let i = 0; i + 1 < nodeSeq.length; i++) {
    const from = nodeSeq[i];
    const to = nodeSeq[i + 1];
    const edge = edgeBetween(graph, from, to);
    edges.push(edge.id);
    cost += costFn(edge, from, userMax);
    lengthM += edge.lengthM;
    if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
      steepEdges.push(edge.id);
    }
  }
  return { nodes: nodeSeq, edges, cost, lengthM, steepEdges };
}

/** The (lowest-cost-by-length) edge connecting two adjacent nodes. */
function edgeBetween(graph: Graph, fromId: string, toId: string): Edge {
  let best: Edge | undefined;
  for (const edgeId of graph.adjacency[fromId] ?? []) {
    const e = edgeById(graph, edgeId);
    if (otherEnd(e, fromId) === toId && (!best || e.lengthM < best.lengthM)) best = e;
  }
  if (!best) throw new Error(`edgeBetween: no edge connects "${fromId}" and "${toId}"`);
  return best;
}

// --- §15.2 stage wrappers ---------------------------------------------------

/** Stage 1: Dijkstra — distance cost, no heuristic. userMax irrelevant. */
export function dijkstra(graph: Graph, startId: string, goalId: string): SearchResult {
  return search(graph, startId, goalId, Infinity, distanceCost, zeroHeuristic);
}

/** Stage 2: A* — distance cost, haversine heuristic. Same path as Dijkstra. */
export function astar(graph: Graph, startId: string, goalId: string): SearchResult {
  return search(graph, startId, goalId, Infinity, distanceCost, haversineHeuristic);
}

/** Stage 3: grade A* — undirected steepness penalty + haversine. */
export function gradeAstar(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number
): SearchResult {
  return search(graph, startId, goalId, userMax, gradeCostAbs, haversineHeuristic);
}

/** Stage 4: directional A* — signed directed-grade penalty + haversine (§4.1). */
export function directedAstar(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number
): SearchResult {
  return search(graph, startId, goalId, userMax, gradeCostDirected, haversineHeuristic);
}
```

Note: `edgeBetween` picks the shortest connecting edge when nodes share more than
one — fine here because the engine's `came` map already chose that edge via cost;
re-resolving by min length matches it for these fixtures. (Plan 2's real graph has
at most one edge per node pair after `split.ts` dedup, so this is unambiguous there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run features/routing/astar.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add features/routing/astar.ts features/routing/astar.test.ts
git commit -m "feat: add parametric search engine and Dijkstra (stage 1)"
```

---

## Task 8: A* with haversine (stage 2) — same path, fewer expansions

**Files:**
- Modify: `features/routing/astar.test.ts` (add a describe block)

- [ ] **Step 1: Add the failing tests**

Append to `features/routing/astar.test.ts`:

```ts
import { astar } from "./astar";
import { makeGridGraph } from "./fixtures";

describe("astar (stage 2, informed search)", () => {
  it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
    const g = makeGridGraph(12);
    const d = dijkstra(g, "0,0", "11,11");
    const a = astar(g, "0,0", "11,11");
    expect(a.path).not.toBeNull();
    expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6);
    expect(a.path!.lengthM).toBeCloseTo(d.path!.lengthM, 6);
  });

  it("expands no more nodes than Dijkstra, usually far fewer", () => {
    const g = makeGridGraph(12);
    const d = dijkstra(g, "0,0", "11,11");
    const a = astar(g, "0,0", "11,11");
    expect(a.nodesExpanded).toBeLessThanOrEqual(d.nodesExpanded);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones pass (no new impl needed)**

Run: `npx vitest run features/routing/astar.test.ts`
Expected: PASS — `astar` already exists from Task 7. Both new tests pass: identical cost, and A* expands ≤ Dijkstra. (If `nodesExpanded` were equal, the heuristic isn't pruning — investigate the grid before proceeding.)

- [ ] **Step 3: Commit**

```bash
git add features/routing/astar.test.ts
git commit -m "test: prove A* matches Dijkstra's path with fewer expansions (stage 2)"
```

---

## Task 9: Grade-cost A* (stage 3) — flat route over steep

**Files:**
- Modify: `features/routing/astar.test.ts` (add a describe block)

- [ ] **Step 1: Add the failing tests**

Append to `features/routing/astar.test.ts`:

```ts
import { gradeAstar } from "./astar";
import { gradeGraph } from "./fixtures";

describe("gradeAstar (stage 3, domain cost)", () => {
  it("prefers the longer flat route over the shorter steep one", () => {
    const g = gradeGraph();
    // distance-only A* takes the short steep path S-H-G
    const plain = astar(g, "S", "G");
    expect(plain.path!.nodes).toEqual(["S", "H", "G"]);
    // grade-aware (userMax = 5%) detours to the flat S-L-G path
    const flat = gradeAstar(g, "S", "G", 5);
    expect(flat.path!.nodes).toEqual(["S", "L", "G"]);
    expect(flat.path!.lengthM).toBeGreaterThan(plain.path!.lengthM); // longer but flat
  });

  it("is symmetric: S->G and G->S give the same route (abs grade)", () => {
    const g = gradeGraph();
    const fwd = gradeAstar(g, "S", "G", 5);
    const rev = gradeAstar(g, "G", "S", 5);
    expect(rev.path!.nodes).toEqual([...fwd.path!.nodes].reverse());
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (no new impl needed)**

Run: `npx vitest run features/routing/astar.test.ts`
Expected: PASS — `gradeAstar` exists from Task 7. The grade router detours to `S,L,G`; abs-grade cost is direction-symmetric.

- [ ] **Step 3: Commit**

```bash
git add features/routing/astar.test.ts
git commit -m "test: prove grade-cost A* chooses the flat route (stage 3)"
```

---

## Task 10: Directional A* (stage 4) — A→B ≠ B→A, and honesty

**Files:**
- Modify: `features/routing/astar.test.ts` (add a describe block)

- [ ] **Step 1: Add the failing tests**

Append to `features/routing/astar.test.ts`:

```ts
import { directedAstar } from "./astar";
import { directionalGraph } from "./fixtures";

describe("directedAstar (stage 4, directional cost + honesty)", () => {
  it("detours uphill but takes the direct edge downhill (A->B != B->A)", () => {
    const g = directionalGraph();
    // X->Y climbs 8% on the direct edge -> detour via F
    const up = directedAstar(g, "X", "Y", 5);
    expect(up.path!.nodes).toEqual(["X", "F", "Y"]);
    // Y->X is downhill on the direct edge -> free, take it directly
    const down = directedAstar(g, "Y", "X", 5);
    expect(down.path!.nodes).toEqual(["Y", "X"]);
  });

  it("still returns an only-steep path and flags the steep edge (§14.4)", () => {
    // graph where the ONLY X->Y connection is the 8% climb (remove the detour)
    const g = directionalGraph();
    g.edges = g.edges.filter((e) => e.id === "xy");
    g.adjacency = { X: ["xy"], Y: ["xy"], F: [] };
    const r = directedAstar(g, "X", "Y", 5);
    expect(r.path).not.toBeNull();
    expect(r.path!.steepEdges).toEqual(["xy"]); // honest: flat-route impossible, flagged
  });

  it("returns null only when genuinely disconnected, not when merely steep", () => {
    const g = directionalGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];
    expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (no new impl needed)**

Run: `npx vitest run features/routing/astar.test.ts`
Expected: PASS — `directedAstar` exists from Task 7; `summarizePath` already populates `steepEdges`. This is the directional + honest-fallback proof (§4.1, §14.4).

- [ ] **Step 3: Run the full suite so far**

Run: `npm test`
Expected: PASS — geo, pqueue, graph, cost, fixtures, astar all green.

- [ ] **Step 4: Commit**

```bash
git add features/routing/astar.test.ts
git commit -m "test: prove directional A* and honest steep-edge flagging (stage 4)"
```

---

## Task 11: `features/routing/bidirectional.ts` — bidirectional A* (stage 5)

Searches forward from start and backward from goal simultaneously, using a
balanced consistent potential so both halves stay admissible, and the standard
`topF + topR >= mu` stopping rule. The reverse search must cost each edge in its
forward travel direction (`fromNode = predecessor`), since `directedGrade` is
asymmetric.

**Files:**
- Create: `features/routing/bidirectional.ts`
- Test: `features/routing/bidirectional.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// features/routing/bidirectional.test.ts
import { describe, it, expect } from "vitest";
import { bidirectional } from "./bidirectional";
import { dijkstra, gradeAstar, directedAstar } from "./astar";
import { distanceCost, gradeCostDirected } from "./cost";
import { diamondGraph, gradeGraph, directionalGraph, makeGridGraph } from "./fixtures";

describe("bidirectional A* (stage 5)", () => {
  it("matches Dijkstra's optimal path on the diamond (distance cost)", () => {
    const g = diamondGraph();
    const b = bidirectional(g, "S", "G", Infinity, distanceCost);
    const d = dijkstra(g, "S", "G");
    expect(b.path!.nodes).toEqual(d.path!.nodes);
    expect(b.path!.cost).toBeCloseTo(d.path!.cost, 6);
  });

  it("matches directional A*'s optimal cost on the grid (directed cost)", () => {
    // Interior pair + userMax=10 (grid30 max grade is 6.25%, so nothing is BLOCKED):
    // a clean grade-aware optimum, not an all-too-steep fallback path.
    const g = makeGridGraph(30);
    const ref = directedAstar(g, "12,12", "17,17", 10);
    const b = bidirectional(g, "12,12", "17,17", 10, gradeCostDirected);
    expect(b.path).not.toBeNull();
    expect(b.path!.cost).toBeCloseTo(ref.path!.cost, 4);
  });

  it("expands far fewer nodes than uninformed Dijkstra (meet-in-the-middle)", () => {
    // EXECUTION FINDING (2026-06-16): bidirectional A* does NOT reliably beat
    // unidirectional A* with a strong near-exact heuristic on a Euclidean grid —
    // it legitimately expands slightly more (e.g. 43 vs 32). Its provable win is
    // meeting in the middle vs the uninformed FLOOD. Compare against Dijkstra with
    // the SAME cost function on an INTERIOR pair (corner-to-corner is degenerate:
    // the goal is the farthest node, so Dijkstra expands the whole graph).
    const g = makeGridGraph(30);
    const dj = dijkstra(g, "12,12", "17,17");
    const b = bidirectional(g, "12,12", "17,17", Infinity, distanceCost);
    expect(b.path!.cost).toBeCloseTo(dj.path!.cost, 6); // same optimal cost
    expect(b.nodesExpanded).toBeLessThan(dj.nodesExpanded); // ~43 << ~203
  });

  it("respects direction like the forward engine (flat fixture)", () => {
    const g = gradeGraph();
    const b = bidirectional(g, "S", "G", 5, gradeCostDirected);
    const ref = directedAstar(g, "S", "G", 5);
    expect(b.path!.cost).toBeCloseTo(ref.path!.cost, 6);
  });

  it("returns null when disconnected", () => {
    const g = directionalGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];
    expect(bidirectional(g, "X", "ISO", 5, gradeCostDirected).path).toBeNull();
  });

  it("handles start === goal", () => {
    const g = diamondGraph();
    const b = bidirectional(g, "S", "S", Infinity, distanceCost);
    expect(b.path!.nodes).toEqual(["S"]);
    expect(b.path!.cost).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run features/routing/bidirectional.test.ts`
Expected: FAIL — cannot find module `./bidirectional`.

- [ ] **Step 3: Write the implementation**

```ts
// features/routing/bidirectional.ts — bidirectional A* with a balanced
// consistent potential (spec §14.5). Forward from start, backward from goal.
import type { CostFn, Edge, Graph, SearchResult } from "./types";
import { PQueue } from "./pqueue";
import { edgeById, otherEnd } from "./graph";
import { haversine } from "../../lib/geo";
import { summarizePath } from "./astar";

export function bidirectional(
  graph: Graph,
  startId: string,
  goalId: string,
  userMax: number,
  costFn: CostFn
): SearchResult {
  let pushes = 0;
  let pops = 0;
  let nodesExpanded = 0;

  const start = graph.nodes[startId];
  const goal = graph.nodes[goalId];
  if (!start || !goal) return { path: null, nodesExpanded, pushes, pops };

  if (startId === goalId) {
    return { path: summarizePath(graph, [startId], userMax, costFn), nodesExpanded, pushes, pops };
  }

  // Balanced potential: pf consistent for forward, pr = -pf consistent for reverse.
  const pf = (id: string) =>
    (haversine(graph.nodes[id], goal) - haversine(graph.nodes[id], start)) / 2;
  const pr = (id: string) => -pf(id);

  const gf = new Map<string, number>([[startId, 0]]);
  const gr = new Map<string, number>([[goalId, 0]]);
  const cameF = new Map<string, { edge: Edge; prev: string }>();
  const cameR = new Map<string, { edge: Edge; next: string }>();
  const closedF = new Set<string>();
  const closedR = new Set<string>();
  const openF = new PQueue<string>();
  const openR = new PQueue<string>();
  openF.push(startId, pf(startId));
  openR.push(goalId, pr(goalId));
  pushes += 2;

  let mu = Infinity; // best total cost found
  let meet: string | null = null;

  while (!openF.isEmpty() && !openR.isEmpty()) {
    const topF = openF.peekPriority()!;
    const topR = openR.peekPriority()!;
    if (topF + topR >= mu) break; // standard stopping rule

    if (topF <= topR) {
      const u = openF.pop()!;
      pops++;
      if (closedF.has(u)) continue;
      closedF.add(u);
      nodesExpanded++;
      for (const edgeId of graph.adjacency[u] ?? []) {
        const edge = edgeById(graph, edgeId);
        const v = otherEnd(edge, u);
        const tentative = gf.get(u)! + costFn(edge, u, userMax); // forward: from = u
        if (tentative < (gf.get(v) ?? Infinity)) {
          gf.set(v, tentative);
          cameF.set(v, { edge, prev: u });
          openF.push(v, tentative + pf(v));
          pushes++;
          if (gr.has(v)) {
            const total = tentative + gr.get(v)!;
            if (total < mu) {
              mu = total;
              meet = v;
            }
          }
        }
      }
    } else {
      const u = openR.pop()!;
      pops++;
      if (closedR.has(u)) continue;
      closedR.add(u);
      nodesExpanded++;
      for (const edgeId of graph.adjacency[u] ?? []) {
        const edge = edgeById(graph, edgeId);
        const v = otherEnd(edge, u); // v is the predecessor in the forward path
        const tentative = gr.get(u)! + costFn(edge, v, userMax); // forward dir: from = v
        if (tentative < (gr.get(v) ?? Infinity)) {
          gr.set(v, tentative);
          cameR.set(v, { edge, next: u });
          openR.push(v, tentative + pr(v));
          pushes++;
          if (gf.has(v)) {
            const total = gf.get(v)! + tentative;
            if (total < mu) {
              mu = total;
              meet = v;
            }
          }
        }
      }
    }
  }

  if (meet === null) return { path: null, nodesExpanded, pushes, pops };

  // Reconstruct start..meet (forward) and meet..goal (reverse), then summarize.
  const front: string[] = [meet];
  let cur = meet;
  while (cur !== startId) {
    const entry = cameF.get(cur)!;
    cur = entry.prev;
    front.push(cur);
  }
  front.reverse(); // [start, ..., meet]

  const back: string[] = [];
  cur = meet;
  while (cur !== goalId) {
    const entry = cameR.get(cur)!;
    cur = entry.next;
    back.push(cur);
  }
  // back = [nodeAfterMeet, ..., goal]; front ends with meet -> concatenate
  const nodes = [...front, ...back];
  return {
    path: summarizePath(graph, nodes, userMax, costFn),
    nodesExpanded,
    pushes,
    pops,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run features/routing/bidirectional.test.ts`
Expected: PASS (6 tests). If the cost-match test fails by a small margin, the meeting rule or reverse-edge direction is off — re-check that the reverse step costs the edge with `from = v` (predecessor), not `from = u`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all modules green.

- [ ] **Step 6: Commit**

```bash
git add features/routing/bidirectional.ts features/routing/bidirectional.test.ts
git commit -m "feat: add bidirectional A* with balanced potential (stage 5)"
```

---

## Task 12: `bench/` — the benchmark harness (§15.3)

Runs every algorithm over fixed (start, goal) pairs on the grid, asserts the
optimal-stage algorithms agree on cost, and prints the comparison table (nodes
expanded, pushes/pops, ms, cost). This table is the portfolio centerpiece.

**Files:**
- Create: `bench/run.ts`
- Create: `bench/report.ts`
- Test: `bench/report.test.ts`

- [ ] **Step 1: Write the failing test for the report formatter**

```ts
// bench/report.test.ts
import { describe, it, expect } from "vitest";
import { formatTable, type BenchRow } from "./report";

describe("formatTable", () => {
  it("renders a row per algorithm with aligned columns", () => {
    const rows: BenchRow[] = [
      { algorithm: "dijkstra", nodesExpanded: 4812, pushes: 9000, pops: 8000, ms: 12.3, cost: 1000 },
      { algorithm: "astar", nodesExpanded: 1107, pushes: 2200, pops: 2000, ms: 3.1, cost: 1000 },
    ];
    const out = formatTable("Pike->Broadway", rows);
    expect(out).toContain("Pike->Broadway");
    expect(out).toContain("dijkstra");
    expect(out).toContain("astar");
    expect(out).toContain("4812");
    // both optimal -> same cost shown
    expect(out).toContain("1000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/report.test.ts`
Expected: FAIL — cannot find module `./report`.

- [ ] **Step 3: Write `bench/report.ts`**

```ts
// bench/report.ts — format benchmark rows into a comparison table (§15.3).
export type BenchRow = {
  algorithm: string;
  nodesExpanded: number;
  pushes: number;
  pops: number;
  ms: number;
  cost: number;
};

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function formatTable(title: string, rows: BenchRow[]): string {
  const header =
    pad("algorithm", 16) +
    padLeft("expanded", 10) +
    padLeft("pushes", 9) +
    padLeft("pops", 9) +
    padLeft("ms", 9) +
    padLeft("cost", 12);
  const lines = rows.map(
    (r) =>
      pad(r.algorithm, 16) +
      padLeft(String(r.nodesExpanded), 10) +
      padLeft(String(r.pushes), 9) +
      padLeft(String(r.pops), 9) +
      padLeft(r.ms.toFixed(2), 9) +
      padLeft(r.cost.toFixed(2), 12)
  );
  return [title, header, ...lines].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/report.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write `bench/run.ts`**

```ts
// bench/run.ts — run every stage over fixed pairs and print the table (§15.3).
// Usage: npm run bench
import { makeGridGraph } from "../features/routing/fixtures";
import { dijkstra, astar, gradeAstar, directedAstar } from "../features/routing/astar";
import { bidirectional } from "../features/routing/bidirectional";
import { distanceCost, gradeCostDirected } from "../features/routing/cost";
import { formatTable, type BenchRow } from "./report";
import { performance } from "node:perf_hooks";
import type { SearchResult } from "../features/routing/types";

// userMax=10 keeps interior grid paths below the grid's 6.25% max grade, so the
// grade router returns a clean optimum (no all-BLOCKED 1e11 costs in the table).
const USER_MAX = 10;

// INTERIOR pairs only. Corner-to-corner is degenerate: the goal is the farthest
// node, so Dijkstra expands the whole graph and NOTHING can be pruned — the table
// would show dijkstra == astar == bidirectional (all-nodes), hiding the very effect
// it exists to demonstrate. Interior pairs leave most of the graph outside the
// search ellipse, so A* drives a narrow cone and bidirectional two meeting cones.
const pairs: Array<{ name: string; start: string; goal: string; size: number }> = [
  { name: "grid30 12,12->17,17 (near interior)", start: "12,12", goal: "17,17", size: 30 },
  { name: "grid40 10,10->30,20 (mid interior)", start: "10,10", goal: "30,20", size: 40 },
  { name: "grid40 18,18->21,21 (short interior)", start: "18,18", goal: "21,21", size: 40 },
];

function time(fn: () => SearchResult): { result: SearchResult; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

for (const { name, start, goal, size } of pairs) {
  const g = makeGridGraph(size);
  // Two sub-stories share one table:
  //  - DISTANCE problem (same optimal cost): dijkstra -> astar -> bidirectional.
  //    Shows search efficiency improving for the SAME answer (§15.2 stages 1,2,5).
  //  - GRADE problem (different, higher cost by design): gradeAstar, directedAstar
  //    (§15.2 stages 3,4) — the domain cost model, not a search-speed comparison.
  // Bidirectional MUST use distanceCost here so it is comparable to dijkstra/astar;
  // benchmarking it with gradeCostDirected against distance-cost rows is apples-to-
  // oranges and can make it look slower than the flood.
  const algos: Array<{ algorithm: string; run: () => SearchResult }> = [
    { algorithm: "dijkstra", run: () => dijkstra(g, start, goal) },
    { algorithm: "astar", run: () => astar(g, start, goal) },
    { algorithm: "bidirectional", run: () => bidirectional(g, start, goal, Infinity, distanceCost) },
    { algorithm: "gradeAstar", run: () => gradeAstar(g, start, goal, USER_MAX) },
    { algorithm: "directedAstar", run: () => directedAstar(g, start, goal, USER_MAX) },
  ];

  const rows: BenchRow[] = [];
  for (const { algorithm, run } of algos) {
    // warm + measure (single run is fine for a portfolio table; note in README it's not a microbench)
    const { result, ms } = time(run);
    rows.push({
      algorithm,
      nodesExpanded: result.nodesExpanded,
      pushes: result.pushes,
      pops: result.pops,
      ms,
      cost: result.path ? result.path.cost : NaN,
    });
  }
  console.log("\n" + formatTable(name, rows));
}
console.log(
  "\nDISTANCE problem (dijkstra/astar/bidirectional, equal cost): A* prunes the flood to a cone;" +
    "\nbidirectional meets in the middle — far fewer expansions than dijkstra, typically slightly more" +
    "\nthan the single A* cone (expected on a near-Euclidean grid, not a bug)." +
    "\nGRADE problem (gradeAstar/directedAstar): higher cost is the grade penalty, by design."
);
```

- [ ] **Step 6: Run the benchmark**

Run: `npm run bench`
Expected: three tables print; for each, `astar` shows fewer `expanded` than `dijkstra` at equal `cost`, and `bidirectional` shows far fewer `expanded` than `dijkstra` (meet-in-the-middle vs flood) — though typically *slightly more* than unidirectional `astar`, which is expected on a near-Euclidean grid with a strong heuristic, not a bug. (`gradeAstar`/`directedAstar` costs differ from the distance algorithms — that's the grade penalty, by design.)

- [ ] **Step 7: Run the full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS; `tsc --noEmit` reports no errors.

- [ ] **Step 8: Commit**

```bash
git add bench/run.ts bench/report.ts bench/report.test.ts
git commit -m "feat: add benchmark harness comparing algorithm stages"
```

---

## Done when

- `npm test` passes: geo, pqueue (incl. property/invariant tests), graph, cost, fixtures, astar (stages 1–4), bidirectional (stage 5), report.
- `npm run typecheck` is clean under `strict`.
- `npm run bench` prints the comparison table: A* expands fewer nodes than Dijkstra at equal cost; bidirectional expands ≤ one-directional A* at equal cost.
- No third-party heap/graph/routing dependency imported (only `tsx`, `typescript`, `vitest` as dev tooling).
- The §15.2 correctness gate holds: Dijkstra, A*, and bidirectional (distance cost) agree on path cost for the same pair.

Next plan (per `ROADMAP.md`): **Plan 2 — data pipeline** (`pipeline/osm.ts → split.ts → elevation.ts → grade.ts → build-graph.ts`), producing the `graph.json` this engine consumes.

---

## Execution findings (2026-06-16)

- **Bidirectional A* vs unidirectional A*.** Measured on the grid fixtures:
  bidirectional does *not* reliably expand fewer nodes than unidirectional A*
  when the heuristic is strong and near-exact (Euclidean grid) — it expanded
  ~43 vs A*'s ~32 on an interior pair. This is the known theory, not a bug.
  Its provable win is meet-in-the-middle vs the *uninformed* flood (43 vs
  Dijkstra's 203). Tasks 11 and 12 assert/​demonstrate that sound invariant.
- **Corner-to-corner is a degenerate routing fixture.** The goal is the farthest
  node, so Dijkstra must expand the whole graph and no algorithm can prune
  (all expand n²−1). Tasks 11 and 12 use **interior** pairs so pruning is visible.
- **Grade benchmark `userMax`.** grid30's max abs grade is 6.25%; `userMax=6`
  blocks edges and yields ~1e11 (BLOCKED-laden) costs. The benchmark uses
  `userMax=10` for a clean grade-aware optimum.

## Self-review notes (spec coverage)

- §4 / §4.1 types and `directedGrade` → Tasks 2, 4. §6 penalty + cost → Task 5. §7 banding is color/UI (Plan 3), out of scope here.
- §14.2 A* sketch → Task 7 `search`; §14.3 admissibility (haversine ≤ length since penalty ≥ 0) → Tasks 1, 7–8; node-identity handled by fixtures' shared node maps; §14.4 flat-vs-disconnected → Task 10.
- §14.5 bidirectional → Task 11. k-alternatives / CH / zones remain documented stretch (ROADMAP).
- pqueue-spec §9 test plan → Task 3; §9.7 Dijkstra baseline → Tasks 6–7; `peekPriority` addition noted in Task 3.
- §15.2 stages 1–5 → Tasks 7–11; §15.3 harness → Task 12. §15.4 search visualization is a map concern → Plan 3.
