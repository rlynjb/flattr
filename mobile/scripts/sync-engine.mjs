// mobile/scripts/sync-engine.mjs — copy the shared TS engine into the app so Metro
// bundles it from INSIDE the project root (Metro won't reliably watch/bundle files
// outside projectRoot). tsc still type-checks the real source at ../features|../lib;
// this is a bundling copy only. Run before building: `node scripts/sync-engine.mjs`.
import { rmSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "../..");
const dest = path.resolve(here, "../.engine");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

for (const dir of ["features", "lib", "pipeline"]) {
  cpSync(path.join(repoRoot, dir), path.join(dest, dir), {
    recursive: true,
    filter: (src) => !src.endsWith(".test.ts"), // skip vitest tests (not app deps)
  });
}
console.log("synced engine -> mobile/.engine (features, lib)");
