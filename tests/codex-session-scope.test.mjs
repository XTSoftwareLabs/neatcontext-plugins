// One scope for every Codex process, and what happens when the host tries to
// split it.
//
// Codex hands its plugin processes very different things. A skill runs through
// the shell tool, which exports CODEX_THREAD_ID. The SessionStart hook is given
// the thread id on stdin. The MCP bridge gets neither: Codex starts it with a
// scrubbed environment, no CODEX_* variable survives into it, its MCP client
// offers no `roots`, and its parent process is not the one the hook was spawned
// from — so no pointer file keyed on the host process joins the two halves.
//
// Scope the selection on any of that and the plugin splits in silence:
// `use_context` connects a context in the bridge and `$neatcontext:status`, run
// a second later, reports that nothing is connected. These tests spawn the
// three process kinds the way Codex spawns them — different environments,
// different host keys — and hold them to one answer.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeSession } from "./process-helpers.mjs";

const plugin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "codex-marketplace",
  "plugins",
  "neatcontext"
);
const codex = path.join(plugin, "src", "codex");

// The host keys stand in for what `process.ppid` resolves to in each process.
// They differ on purpose: on Codex they really are different processes, and a
// plugin that only works when they agree does not work.
const BRIDGE_HOST = "codex-window";
const HOOK_HOST = "codex-hook-runner";
const SHELL_HOST = "codex-shell";
const THREAD = "01a02647-61ec-76a1-9571-ccfb40c1b415";

let home;
let hostsDirectory;

function childEnv({ thread = null, host, sessionId = null } = {}) {
  const env = { ...process.env, NEATCONTEXT_HOME: home, NEATCONTEXT_HOST_KEY: host };
  delete env.CODEX_THREAD_ID;
  delete env.NEATCONTEXT_SESSION_ID;
  if (thread) env.CODEX_THREAD_ID = thread;
  if (sessionId) env.NEATCONTEXT_SESSION_ID = sessionId;
  return env;
}

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-scope-"));
  hostsDirectory = path.join(home, "plugin-hosts");
  const docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "payments.md"), "# Payments\n");
  process.env.NEATCONTEXT_HOME = home;
  const store = await import(
    "../codex-marketplace/plugins/neatcontext/src/core/context-store.mjs"
  );
  for (const name of ["payment team", "Dokploy"]) {
    await store.createContext({
      name,
      knowledgeFolder: docs,
      profile: `# ${name}\n\n## Purpose\nQuestions about ${name}.`
    });
  }
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(hostsDirectory, { recursive: true, force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
});

// A skill: Codex runs it through the shell tool, so it is the one process that
// is handed the thread id.
function cli(...args) {
  const options = typeof args.at(-1) === "object" ? args.pop() : {};
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(codex, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv({ thread: THREAD, host: SHELL_HOST, ...options })
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// What Codex runs when a thread starts, resumes, or compacts. It is told the
// thread id on stdin and spawned from its own parent.
function sessionStart(threadId, source = "startup") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(plugin, "hooks", "session-start.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv({ host: HOOK_HOST })
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
    child.stdin.end(
      JSON.stringify({ session_id: threadId, source, hook_event_name: "SessionStart" })
    );
  });
}

// The MCP bridge: one per window, started with nothing that names a thread.
function openWindow({ sessionId = null } = {}) {
  const child = spawn(process.execPath, [path.join(codex, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv({ host: BRIDGE_HOST, sessionId })
  });
  const waiters = new Map();
  const notifications = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    } else {
      notifications.push(message);
    }
  });
  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    pid: child.pid,
    notifications,
    async handshake() {
      const response = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      return response;
    },
    call: async (name, args = {}) =>
      (await send("tools/call", { name, arguments: args })).result.content[0].text,
    grounding: async () =>
      (await send("tools/call", { name: "get_context", arguments: {} })).result.content[0].text,
    close: () => closeSession(child)
  };
}

async function waitFor(predicate, { timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a context the session routes itself to", () => {
  it("is the context the skills report", async () => {
    const window = openWindow();
    try {
      await window.handshake();
      assert.match(
        await window.call("use_context", { context: "payment team", reason: "test" }),
        /Switched this session to "payment team"/
      );

      // The bug this file exists for: connected in the bridge, invisible to
      // every command the user can run.
      assert.match(await cli("status"), /Connected context: payment team/);
      assert.match(await cli("list"), /payment team\s+\(connected\)/);
    } finally {
      await window.close();
    }
  });

  it("is still the one the skills report after the thread changes", async () => {
    const window = openWindow();
    try {
      await window.handshake();
      await window.call("use_context", { context: "payment team", reason: "test" });

      // `/new`: a new thread id, delivered to the hook and to every later
      // skill. Nothing about it can move the selection out from under the
      // bridge, because nothing is scoped to it.
      await sessionStart("01a0300f-0000-7000-8000-00000000beef", "clear");

      assert.match(await window.grounding(), /connected context: payment team/);
      assert.match(
        await cli("status", { thread: "01a0300f-0000-7000-8000-00000000beef" }),
        /Connected context: payment team/
      );
    } finally {
      await window.close();
    }
  });
});

describe("a context a skill connects", () => {
  it("is what the bridge serves", async () => {
    const window = openWindow();
    try {
      await window.handshake();
      assert.match(await cli("use", "Dokploy"), /Connected the "Dokploy" context/);
      assert.match(await window.grounding(), /connected context: Dokploy/);

      assert.match(await cli("disconnect"), /Disconnected the "Dokploy" context/);
      assert.match(await window.grounding(), /No NeatContext Context is connected/);
    } finally {
      await window.close();
    }
  });

  it("makes the bridge tell the host its tool list changed", async () => {
    const window = openWindow();
    try {
      await window.handshake();
      await window.grounding();
      window.notifications.length = 0;

      await cli("use", "payment", "team");

      const announced = await waitFor(() =>
        window.notifications.some(
          (message) => message.method === "notifications/tools/list_changed"
        )
      );
      assert.ok(announced, "the bridge never announced that its tool list had changed");
    } finally {
      await window.close();
    }
  });

  it("is named by the routing menu the hook re-injects", async () => {
    await cli("use", "payment", "team");

    const { hookSpecificOutput } = JSON.parse(await sessionStart(THREAD));
    assert.equal(hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(hookSpecificOutput.additionalContext, /The "payment team" context is connected/);
    assert.doesNotMatch(hookSpecificOutput.additionalContext, /No NeatContext context is connected/);
  });
});

describe("the routing mode a skill sets", () => {
  it("is the mode the bridge enforces", async () => {
    assert.match(await cli("mode", "manual"), /Context routing is now manual/);

    const window = openWindow();
    try {
      await window.handshake();
      assert.match(
        await window.call("use_context", { context: "payment team", reason: "test" }),
        /Context routing is off \(manual mode\)/
      );
      assert.match(await cli("status"), /No context is connected yet/);
    } finally {
      await window.close();
    }
  });
});

describe("a pointer file left by an older version of this plugin", () => {
  it("does not re-scope the bridge onto a thread the skills cannot see", async () => {
    await mkdir(hostsDirectory, { recursive: true });
    await writeFile(
      path.join(hostsDirectory, `${BRIDGE_HOST}.json`),
      JSON.stringify({
        sessionId: THREAD,
        source: "session-start",
        updatedAt: new Date().toISOString()
      })
    );

    const window = openWindow();
    try {
      await window.handshake();
      await window.call("use_context", { context: "payment team", reason: "test" });
      assert.match(await cli("status"), /Connected context: payment team/);
      // Nothing was written per thread, so nothing can be read per thread.
      assert.deepEqual(await readdir(path.join(home, "plugin-sessions")).catch(() => []), []);
    } finally {
      await window.close();
    }
  });

  it("is swept by the hook once its process is gone", async () => {
    await mkdir(hostsDirectory, { recursive: true });
    // Above Linux's pid ceiling and not a multiple of four, which Windows pids
    // are: no platform can have handed this one out.
    await writeFile(path.join(hostsDirectory, "pid-2147483647.json"), JSON.stringify({}));

    await sessionStart(THREAD);

    assert.deepEqual(await readdir(hostsDirectory).catch(() => []), []);
  });
});

describe("a host that can name a session in every one of its processes", () => {
  it("gets its selection scoped to that session", async () => {
    const session = "explicit-session";
    const window = openWindow({ sessionId: session });
    try {
      await window.handshake();
      await window.call("use_context", { context: "payment team", reason: "test" });

      assert.match(
        await cli("status", { sessionId: session }),
        /Connected context: payment team/
      );
      assert.deepEqual(await readdir(path.join(home, "plugin-sessions")), [`${session}.json`]);
      // A different session of that host keeps its own.
      assert.match(await cli("status", { sessionId: "another-session" }), /No context is connected/);
    } finally {
      await window.close();
    }
  });
});
