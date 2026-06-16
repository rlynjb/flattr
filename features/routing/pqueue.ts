// Generic lazy-deletion binary min-heap. Knows nothing about graphs/grades.
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
