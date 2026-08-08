// Diff coverage gate: every source line this branch adds or changes must be
// executed by the test suite.
//
// Whole-file coverage numbers are not the goal here — the plugin has plenty of
// code that predates the tests. What has to hold is that new code arrives with
// a test that runs it, so the requirement is scoped to the lines a pull request
// actually touches.
//
// The awkward part is where this plugin's code runs. `node --test
// --experimental-test-coverage` only instruments the test runner's own process,
// and almost everything here is exercised the way Claude Code exercises it:
// `plugins/claude-code/neatcontext/src/claude/mcp-bridge.mjs` and
// `plugins/claude-code/neatcontext/src/claude/neatcontext-cli.mjs` are spawned
// as child processes. So instead we set NODE_V8_COVERAGE, which every child
// inherits, and merge what the whole process tree wrote.
//
// The plugin is dependency-free and stays that way: this reads V8's own
// coverage JSON and `git diff` directly.
//
//   node tools/diff-coverage.mjs [--base <ref>] [--coverage-dir <dir>]
//
// --base          what to diff against (default: origin/main, then main)
// --coverage-dir  reuse an existing NODE_V8_COVERAGE directory instead of
//                 running the tests

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_PLUGIN_ROOT = "plugins/claude-code/neatcontext";

// Every host's shipped code, not just Claude Code's.
//
// The gate watched one plugin for a while, which was fine when the other hosts
// were forks that rarely moved. It stopped being fine the moment a change had
// to be applied to five bridges at once: the four ports sailed through a green
// coverage job that had not looked at a single line of them.
//
// Each host's own adapter directory is listed rather than matched by a pattern,
// so adding a host is a deliberate edit here and a new plugin cannot arrive
// ungated by accident.
const GATED_DIRECTORIES = [
  `${CLAUDE_PLUGIN_ROOT}/src/`,
  "plugins/copilot/neatcontext/src/copilot/",
  "plugins/kimi-code/neatcontext/src/kimi/",
  "plugins/pi/neatcontext/src/pi/",
  "plugins/pi/neatcontext/extensions/",
  "codex-marketplace/plugins/neatcontext/src/codex/"
];

// The Context core is authored once in shared/core and copied verbatim into
// every plugin, and two separate checks already prove those copies identical:
// `sync-context-core.mjs --check` fails CI when one drifts, and the host tests
// assert byte-equality against Claude Code's. Claude's copy is gated above and
// is the one the unit tests import directly.
//
// So gating the other four copies would demand that the same line be executed
// five times over to prove something already proven by equality. It would add
// no safety and would fail honest changes. Host-specific code, which is not
// generated and not identical, is gated everywhere.
const GENERATED_CORE = /^(plugins|codex-marketplace\/plugins)\/[^/]+\/neatcontext\/src\/core\//;

// Tests are excluded on purpose: a test file is covered by definition, and
// counting it would only dilute the gate.
export function isGatedFile(repoRelativePath) {
  if (!/\.(mjs|js)$/.test(repoRelativePath)) {
    return false;
  }
  if (
    GENERATED_CORE.test(repoRelativePath) &&
    !repoRelativePath.startsWith(`${CLAUDE_PLUGIN_ROOT}/src/`)
  ) {
    return false;
  }
  return GATED_DIRECTORIES.some((directory) => repoRelativePath.startsWith(directory));
}

// --- what changed ------------------------------------------------------------

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Added and modified lines, by file, from `git diff --unified=0`. With no
// context lines every line a hunk claims on the `+` side is a line this branch
// is responsible for; deletions contribute nothing to cover.
export function parseDiffLines(diff) {
  const changed = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.*)$/.exec(line);
    if (header) {
      file = header[1] === "/dev/null" ? null : header[1];
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue; // pure deletion
    const lines = changed.get(file) ?? new Set();
    for (let n = start; n < start + count; n += 1) {
      lines.add(n);
    }
    changed.set(file, lines);
  }
  return changed;
}

function resolveBase(explicit) {
  const candidates = explicit ? [explicit] : ["origin/main", "main"];
  for (const candidate of candidates) {
    const mergeBase = git(["merge-base", candidate, "HEAD"], { allowFailure: true });
    if (mergeBase) {
      return { ref: candidate, sha: mergeBase.trim() };
    }
  }
  throw new Error(
    `Could not resolve a base commit (tried ${candidates.join(", ")}). Pass --base <ref>.`
  );
}

// --- what ran ----------------------------------------------------------------

function runTests(coverageDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`node --test exited with ${code}`));
      }
    });
  });
}

// Which characters of a source file V8 saw run. Ranges nest — a never-taken
// branch is a zero-count range inside its function's non-zero one — so the
// innermost range wins, applied by painting the widest ranges first.
export function characterCounts(ranges, length) {
  const counts = new Int32Array(length).fill(-1); // -1: no range says anything
  const widestFirst = [...ranges].sort(
    (a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset)
  );
  for (const range of widestFirst) {
    const start = Math.max(0, range.startOffset);
    const end = Math.min(length, range.endOffset);
    for (let i = start; i < end; i += 1) {
      counts[i] = range.count;
    }
  }
  return counts;
}

// Line-level coverage, istanbul-style: a line counts as covered when anything
// on it ran. `if (x) return;` with the return never taken is a missed branch,
// not a missed line, and this gate is about lines.
//
// No range at all means no evidence the line ran, which is the same answer as a
// zero-count one — that is what makes a file no process ever loaded read as
// entirely uncovered rather than entirely fine.
export function uncoveredLines(source, ranges) {
  const counts = characterCounts(ranges, source.length);
  const uncovered = new Set();
  let line = 1;
  let sawCode = false;
  let sawRun = false;
  const endLine = () => {
    if (sawCode && !sawRun) {
      uncovered.add(line);
    }
    sawCode = false;
    sawRun = false;
  };
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      endLine();
      line += 1;
      continue;
    }
    if (/\s/.test(source[i])) continue;
    sawCode = true;
    if (counts[i] > 0) {
      sawRun = true;
    }
  }
  endLine();
  return uncovered;
}

// Merges the V8 coverage every process in the tree wrote. A line is covered if
// any single process ran it, so intersecting each process's uncovered set is
// enough — no need to sum counts across files.
export async function collectUncovered(coverageDir, wantedFiles) {
  const sources = new Map();
  for (const file of wantedFiles) {
    sources.set(file, await readFile(path.join(REPO_ROOT, file), "utf8"));
  }
  const uncovered = new Map(); // file -> lines no process has run yet
  const seen = new Set();

  for (const entry of await readdir(coverageDir)) {
    if (!entry.endsWith(".json")) continue;
    let report;
    try {
      report = JSON.parse(await readFile(path.join(coverageDir, entry), "utf8"));
    } catch {
      continue; // a process killed mid-write; another one will have the same file
    }
    for (const script of report.result ?? []) {
      if (typeof script.url !== "string" || !script.url.startsWith("file:")) continue;
      const relative = path.relative(REPO_ROOT, fileURLToPath(script.url)).split(path.sep).join("/");
      if (!sources.has(relative)) continue;
      const ranges = (script.functions ?? []).flatMap((fn) => fn.ranges ?? []);
      const missing = uncoveredLines(sources.get(relative), ranges);
      if (seen.has(relative)) {
        const both = [...uncovered.get(relative)].filter((line) => missing.has(line));
        uncovered.set(relative, new Set(both));
      } else {
        seen.add(relative);
        uncovered.set(relative, missing);
      }
    }
  }

  // A file no process ever loaded has nothing covered.
  for (const file of wantedFiles) {
    if (!seen.has(file)) {
      uncovered.set(file, uncoveredLines(sources.get(file), []));
    }
  }
  return uncovered;
}

// --- report ------------------------------------------------------------------

function formatRanges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i];
    while (sorted[i + 1] === sorted[i] + 1) i += 1;
    parts.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
  }
  return parts.join(", ");
}

async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") options.base = argv[++i];
    else if (argv[i] === "--coverage-dir") options.coverageDir = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  const base = resolveBase(options.base);
  const diff = git(["diff", "--unified=0", "--no-color", base.sha]);
  // `isGatedFile` is the only place that decides what the gate covers.
  const changed = new Map([...parseDiffLines(diff)].filter(([file]) => isGatedFile(file)));

  if (changed.size === 0) {
    console.log(`No gated files changed against ${base.ref} (${base.sha.slice(0, 8)}).`);
    return 0;
  }

  let coverageDir = options.coverageDir;
  let temporary = null;
  if (!coverageDir) {
    temporary = await mkdtemp(path.join(os.tmpdir(), "neatcontext-coverage-"));
    coverageDir = temporary;
    await runTests(coverageDir);
  }

  let uncovered;
  try {
    uncovered = await collectUncovered(coverageDir, [...changed.keys()]);
  } finally {
    if (temporary) {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  console.log(`\nDiff coverage against ${base.ref} (${base.sha.slice(0, 8)}):`);
  let changedTotal = 0;
  const failures = [];
  for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    // Blank and comment lines are never reported as uncovered, so they cost
    // nothing here: only executable changed lines can fail the gate.
    const missed = [...lines].filter((line) => uncovered.get(file).has(line));
    changedTotal += lines.size;
    console.log(
      `  ${file}: ${lines.size} changed lines, ${missed.length} uncovered` +
        (missed.length > 0 ? ` (${formatRanges(missed)})` : "")
    );
    if (missed.length > 0) {
      failures.push(`  ${file}: ${formatRanges(missed)}`);
    }
  }

  if (failures.length === 0) {
    console.log(`\nAll ${changedTotal} changed lines are covered.`);
    return 0;
  }
  console.error("\nChanged lines that no test ran:");
  for (const failure of failures) {
    console.error(failure);
  }
  console.error(
    "\nAdd a test that runs them, or move code that genuinely cannot be tested out of the diff."
  );
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
