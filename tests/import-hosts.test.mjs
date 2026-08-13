// The import command, host by host.
//
// What a bundle means — new, current, diverged — is host-neutral and tested
// once in import-reconcile. What this checks is that every host's CLI is
// actually wired to that decision rather than to the older create-only path,
// because a host left behind would answer a second import by silently building
// a duplicate context.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOSTS = [
  {
    name: "Claude Code",
    dir: path.join(root, "plugins", "claude-code", "neatcontext", "src", "claude"),
    session: { CLAUDE_CODE_SESSION_ID: "import-host-test" },
    useCommand: "/neatcontext:use"
  },
  {
    name: "Codex",
    dir: path.join(root, "codex-marketplace", "plugins", "neatcontext", "src", "codex"),
    session: { CODEX_THREAD_ID: "import-host-test" },
    useCommand: "$neatcontext:use"
  },
  {
    name: "GitHub Copilot",
    dir: path.join(root, "plugins", "copilot", "neatcontext", "src", "copilot"),
    session: { NEATCONTEXT_SESSION_ID: "import-host-test" },
    useCommand: "/neatcontext:use"
  },
  {
    name: "Kimi Code",
    dir: path.join(root, "plugins", "kimi-code", "neatcontext", "src", "kimi"),
    session: {},
    cliArgs: ["--session-id", "import-host-test"],
    useCommand: "/neatcontext:use"
  }
];

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.once("error", reject);
    child.once("close", () => resolve(out.trim()));
  });
}

// Written by hand rather than through save and export: this is about the
// command wiring, and a fixed bundle keeps every host reading the same bytes.
async function writeBundle(directory, { id, revision = 1, note = "Shared work." }) {
  await mkdir(path.join(directory, "knowledge"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(directory, "context.json"),
    `${JSON.stringify(
      {
        schema: 2,
        id,
        name: "Shared Incident",
        profileFile: "profile.md",
        createdAt: now,
        updatedAt: now,
        revision,
        knowledgeFolder: "knowledge",
        knowledgeManaged: true,
        capturedFrom: "conversation",
        routingDescription: "Checkout 5xx, pgbouncer pool exhaustion, INC-* tickets"
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(directory, "profile.md"),
    "# Shared Incident\n\n## Purpose\nCarry the incident findings.\n\n" +
      "## What to do\nUse the recorded root cause.\n\n## What to avoid\nDo not re-derive it.\n\n" +
      "## Behavior\nCite the runbook.\n"
  );
  await writeFile(path.join(directory, "knowledge", "session-summary.md"), `# Summary\n\n${note}\n`);
  return directory;
}

describe("every host resolves an import rather than always creating", () => {
  for (const host of HOSTS) {
    it(`${host.name} imports once, then reports the same bundle as current`, async (t) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-import-host-"));
      t.after(async () => {
        await rm(home, { recursive: true, force: true });
      });
      const cli = path.join(host.dir, "neatcontext-cli.mjs");
      const env = { ...process.env, NEATCONTEXT_HOME: home, ...host.session };
      const call = (...args) => run(cli, [...(host.cliArgs ?? []), ...args], env);

      const bundle = await writeBundle(path.join(home, "bundle"), {
        id: "context:shared-incident-aabbccddeeff"
      });

      const first = await call("import", "--from", bundle);
      assert.match(first, /Imported the "Shared Incident" conversation context/);
      assert.match(
        first,
        new RegExp(`Connect it with:\\s+${host.useCommand.replace("$", "\\$")} Shared Incident`)
      );

      const second = await call("import", "--from", bundle);
      assert.match(second, /Import action: current/, `${host.name} re-imported instead of resolving`);
      assert.doesNotMatch(second, /Imported the "Shared Incident"/);
    });
  }
});
