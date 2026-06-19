// mobile/src/elevCache.ts — elevation cache (in-memory + on-disk), keyed by ~90m DEM
// cell. Persists across app restarts so already-fetched areas never re-hit the free
// elevation API (the main cause of throttling). DEM samples never change, so cached
// values are valid forever. Writes are debounced and batched.
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "flattr.elevCache.v1";
const PERSIST_DEBOUNCE_MS = 4000;
const MAX_ENTRIES = 50000; // safety cap; oldest entries drop first (Map keeps insert order)

const mem = new Map<string, number>();
let loaded = false;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Load the persisted cache into memory. Safe to call repeatedly (runs once). */
export async function loadElevCache(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const k in obj) if (!mem.has(k)) mem.set(k, obj[k]);
    }
  } catch {
    // corrupt/unavailable — start from whatever is already in memory
  }
}

export function getElev(key: string): number | undefined {
  return mem.get(key);
}

export function putElev(key: string, value: number): void {
  if (mem.has(key)) return;
  mem.set(key, value);
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  persistTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    let entries = [...mem.entries()];
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
      mem.clear();
      for (const [k, v] of entries) mem.set(k, v);
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    dirty = true; // failed — retry on the next put
  }
}
