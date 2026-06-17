// Lets the app import the shared TS engine at the repo root as `features/*` and `lib/*`.
// Metro won't resolve relative imports that escape the project root (../../features),
// and delegating an extension-less absolute path back to Metro fails too — so we probe
// for the real file and return it directly. The engine's own intra-repo relative imports
// (e.g. features/routing/astar -> ../../lib/geo) resolve normally since repoRoot is watched.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

// The engine is synced INTO the project at mobile/.engine by scripts/sync-engine.mjs
// (run before bundling). Metro reliably bundles files under projectRoot; cross-root
// watchFolders to the repo parent do not work here. tsc still checks the real source.
const aliases = {
  features: path.resolve(projectRoot, ".engine/features"),
  lib: path.resolve(projectRoot, ".engine/lib"),
};

const config = getDefaultConfig(projectRoot);
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
const EXTS = ["ts", "tsx", "js", "jsx", "json"];

function resolveAliasFile(base) {
  for (const e of EXTS) {
    const f = `${base}.${e}`;
    if (fs.existsSync(f)) return f;
  }
  for (const e of EXTS) {
    const f = path.join(base, `index.${e}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const [alias, dir] of Object.entries(aliases)) {
    if (moduleName === alias || moduleName.startsWith(alias + "/")) {
      const base = path.join(dir, moduleName.slice(alias.length));
      const file = resolveAliasFile(base);
      if (file) return { type: "sourceFile", filePath: file };
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
