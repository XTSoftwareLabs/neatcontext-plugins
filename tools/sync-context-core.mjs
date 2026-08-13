// The local Context core is authored once and packaged into every host plugin.
// Installed plugins cannot import outside their own directory, so the repository
// commits generated copies and this script keeps them identical.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "context-store.mjs",
  "extension-bindings.mjs",
  "extension-commands.mjs",
  "extension-runtime.mjs",
  "extensions.mjs",
  "import-commands.mjs",
  "local-state.mjs",
  "mcp-stdio-client.mjs",
  "routing.mjs",
  "routing-search.mjs",
  "routing-candidates.mjs",
  "selection.mjs",
  "storage-home.mjs"
];
const packages = [
  "plugins/claude-code/neatcontext/src/core",
  "plugins/copilot/neatcontext/src/core",
  "plugins/kimi-code/neatcontext/src/core",
  "plugins/pi/neatcontext/src/core",
  "codex-marketplace/plugins/neatcontext/src/core"
];

const check = process.argv.includes("--check");
const stale = [];

for (const file of files) {
  const source = path.join(root, "shared", "core", file);
  const canonical = await readFile(source, "utf8");
  for (const packageDirectory of packages) {
    const target = path.join(root, ...packageDirectory.split("/"), file);
    if (check) {
      const packaged = await readFile(target, "utf8").catch(() => null);
      if (packaged !== canonical) stale.push(path.relative(root, target));
      continue;
    }
    await writeFile(target, canonical, "utf8");
  }
}

if (stale.length > 0) {
  throw new Error(
    `Packaged Context core is stale: ${stale.join(", ")}. ` +
      "Run `npm run sync:context`."
  );
}

if (!check) {
  process.stdout.write(
    `Synced ${files.length} Context core files into ${packages.length} host plugins.\n`
  );
}
