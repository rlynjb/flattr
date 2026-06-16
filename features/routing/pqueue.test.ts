import { describe, it, expect } from "vitest";
import { PQueue } from "./pqueue";

// Deterministic LCG so the property tests are reproducible.
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
    let prev = -Infinity;
    for (let i = 0; i < 50; i++) {
      const p = pq.peekPriority()!;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
      pq.pop();
    }
    for (let i = 100; i < 150; i++) pq.push(i, Math.floor(rand() * 100));
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
