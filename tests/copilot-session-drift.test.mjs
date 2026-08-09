// Regression tests for the reported failure on GitHub Copilot: `/neatcontext:use`
// reports a context connected while `get_context` keeps answering from a
// different one — with no error anywhere, because both halves are telling the
// truth about different files.
//
// Copilot's two plugin processes are not given the same working directory. The
// MCP bridge is spawned with the *plugin installation* directory; the CLI a
// slash command runs is spawned with the user's workspace. The adapter derived
// the session by hashing `process.cwd()`, so the two halves hashed different
// paths and scoped to different selection files.
//
// What is reproduced here is exactly that split, and nothing else: one bridge
// process with the plugin directory as its cwd, CLI processes with the workspace
// as theirs. Copilot ships no hooks, so the CLI is the only process that can
// ever tell the bridge what session the window is on.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeSession } from "./process-helpers.mjs";

const plugin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "copilot",
  "neatcontext"
);
const copilot = path.join(plugin, "src", "copilot");

const HOST = "copilot-window";
const OTHER_HOST = "copilot-window-2";

let home;
let workspace;
let otherWorkspace;
let hostsDirectory;

// The environment Copilot hands a plugin process. `NEATCONTEXT_HOST_KEY` stands
// in for COPILOT_LOADER_PID so a test can say which window a process belongs to
// without depending on the real process tree.
function childEnv({ sessionId, host = HOST } = {}) {
  return {
    ...process.env,
    // Empty is "not set" everywhere it is read, so a test that omits the session
    // id exercises the workspace fallback even though this suite is itself run
    // from a Copilot session whose id would otherwise be inherited.
    COPILOT_AGENT_SESSION_ID: sessionId ?? "",
    COPILOT_LOADER_PID: "",
    NEATCONTEXT_SESSION_ID: "",
    NEATCONTEXT_HOST_KEY: host,
    NEATCONTEXT_HOME: home
  };
}

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-copilot-drift-"));
  workspace = await mkdtemp(path.join(os.tmpdir(), "copilot-workspace-"));
  otherWorkspace = await mkdtemp(path.join(os.tmpdir(), "copilot-workspace-b-"));
  hostsDirectory = path.join(home, "plugin-hosts");
  const docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "payments.md"), "# Payments\n");
  process.env.NEATCONTEXT_HOME = home;
  const store = await import("../plugins/copilot/neatcontext/src/core/context-store.mjs");
  for (const name of ["payment team", "Dokploy"]) {
    await store.createContext({
      name,
      knowledgeFolder: docs,
      profile: `# ${name}\n\n## Purpose\nQuestions about ${name}.`
    });
  }
});

after(async () => {
  for (const directory of [home, workspace, otherWorkspace]) {
    await rm(directory, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await rm(hostsDirectory, { recursive: true, force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
});

// A slash command. Copilot spawns it in the user's workspace — which is the
// directory the bridge is *not* given.
function cli(args, { sessionId, host = HOST, cwd = workspace } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(copilot, "neatcontext-cli.mjs"), ...args],
      { cwd, stdio: ["ignore", "pipe", "inherit"], env: childEnv({ sessionId, host }) }
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// A window: one bridge kept alive for its lifetime, spawned the way Copilot
// spawns it — with the plugin installation directory as its working directory,
// not the workspace.
function openWindow({ sessionId, host = HOST, cwd = plugin } = {}) {
  const child = spawn(process.execPath, [path.join(copilot, "mcp-bridge.mjs")], {
    cwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv({ sessionId, host })
  });
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
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
    send,
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
    grounding: async () =>
      (await send("tools/call", { name: "get_context", arguments: {} })).result.content[0].text,
    close: () => closeSession(child)
  };
}

async function writeBridgeRecord(sessionId, { pid = process.pid, host = HOST } = {}) {
  await mkdir(hostsDirectory, { recursive: true });
  await writeFile(
    path.join(hostsDirectory, `${host}.bridge.json`),
    JSON.stringify({ pid, sessionId, updatedAt: new Date().toISOString() })
  );
}

describe("a bridge and a slash command that were given different directories", () => {
  it("serves the context the slash command just connected", async () => {
    // The reported bug, reproduced by the cwd difference alone: before the fix
    // this connected one selection file and read another, and reported success.
    const window = openWindow({ sessionId: "copilot-session-a" });
    try {
      await window.handshake();
      assert.match(
        await cli(["use", "payment team"], { sessionId: "copilot-session-a" }),
        /Connected the "payment team" context/
      );
      assert.match(await window.grounding(), /connected context: payment team/i);
    } finally {
      await window.close();
    }
  });

  it("agrees even when the host publishes no session id at all", async () => {
    // An older or different Copilot build: the workspace digest is all there is,
    // and the bridge's cwd digest is not the workspace's. The pointer the CLI
    // writes is what closes the gap.
    const window = openWindow({});
    try {
      await window.handshake();
      await cli(["use", "Dokploy"]);
      assert.match(await window.grounding(), /connected context: Dokploy/i);
    } finally {
      await window.close();
    }
  });

  it("stops serving a context once the session is disconnected", async () => {
    const window = openWindow({ sessionId: "copilot-session-a" });
    try {
      await window.handshake();
      await cli(["use", "payment team"], { sessionId: "copilot-session-a" });
      assert.match(await window.grounding(), /connected context: payment team/i);

      await cli(["disconnect"], { sessionId: "copilot-session-a" });
      const answer = await window.grounding();
      assert.doesNotMatch(answer, /connected context: payment team/i);
      assert.match(answer, /No NeatContext Context is connected to this session/);
    } finally {
      await window.close();
    }
  });
});

describe("a session that is replaced under a running bridge", () => {
  it("follows the session the user is in now", async () => {
    const window = openWindow({ sessionId: "copilot-session-a" });
    try {
      await window.handshake();
      await cli(["use", "payment team"], { sessionId: "copilot-session-a" });
      assert.match(await window.grounding(), /connected context: payment team/i);

      // A new session in the same window. Copilot does not restart the bridge,
      // so its own environment still says session-a.
      assert.match(
        await cli(["use", "Dokploy"], { sessionId: "copilot-session-b" }),
        /Connected the "Dokploy" context/
      );
      const answer = await window.grounding();
      assert.match(answer, /connected context: Dokploy/i);
      assert.doesNotMatch(answer, /connected context: payment team/i);
    } finally {
      await window.close();
    }
  });
});

describe("two windows", () => {
  it("do not share a selection", async () => {
    const first = openWindow({ sessionId: "copilot-session-a", host: HOST });
    const second = openWindow({ sessionId: "copilot-session-b", host: OTHER_HOST });
    try {
      await first.handshake();
      await second.handshake();
      await cli(["use", "payment team"], { sessionId: "copilot-session-a", host: HOST });

      assert.match(await first.grounding(), /connected context: payment team/i);
      const other = await second.grounding();
      assert.doesNotMatch(other, /connected context: payment team/i);
      assert.match(other, /No NeatContext Context is connected to this session/);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("keep separate selections when neither publishes a session id", async () => {
    const first = openWindow({ host: HOST });
    const second = openWindow({ host: OTHER_HOST });
    try {
      await first.handshake();
      await second.handshake();
      await cli(["use", "payment team"], { host: HOST, cwd: workspace });
      await cli(["use", "Dokploy"], { host: OTHER_HOST, cwd: otherWorkspace });

      assert.match(await first.grounding(), /connected context: payment team/i);
      assert.match(await second.grounding(), /connected context: Dokploy/i);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe("an explicit session id", () => {
  it("still overrides everything the host publishes", async () => {
    const env = { ...childEnv({ sessionId: "copilot-session-a" }), NEATCONTEXT_SESSION_ID: "pinned" };
    const run = (args, cwd) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(copilot, "neatcontext-cli.mjs"), ...args],
          { cwd, stdio: ["ignore", "pipe", "inherit"], env }
        );
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("exit", () => resolve(out.trim()));
      });

    await run(["use", "payment team"], workspace);
    // A different workspace and a different session id: the pin is what decides,
    // so the selection is found again.
    assert.match(await run(["status"], otherWorkspace), /Connected context: payment team/i);
    const selection = JSON.parse(
      await readFile(path.join(home, "plugin-sessions", "pinned.json"), "utf8")
    );
    assert.ok(selection);
  });
});

describe("a host that publishes no identity at all", () => {
  // Neither a session id nor a pid: the bridge and the CLI are back to hashing
  // their own working directories with no channel between them. Nothing
  // downstream can detect that, so what is pinned here is that the user is told.
  function bare(args, cwd = workspace) {
    return new Promise((resolve) => {
      const env = { ...childEnv({}), NEATCONTEXT_HOST_KEY: "" };
      const child = spawn(
        process.execPath,
        [path.join(copilot, "neatcontext-cli.mjs"), ...args],
        { cwd, stdio: ["ignore", "pipe", "pipe"], env }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", () => resolve({ stdout: stdout.trim(), stderr: stderr.trim() }));
    });
  }

  it("says so rather than failing silently", async () => {
    const { stderr } = await bare(["status"]);
    assert.match(stderr, /publishes no session identity/);
    assert.match(stderr, /NEATCONTEXT_SESSION_ID/);
  });

  it("still scopes to the workspace, so one window keeps working", async () => {
    await bare(["use", "payment team"]);
    assert.match((await bare(["status"])).stdout, /Connected context: payment team/i);
    assert.match((await bare(["status"], otherWorkspace)).stdout, /No context is connected/);
  });

  it("stays quiet as soon as the host publishes either one", async () => {
    const withSession = await cli(["status"], { sessionId: "copilot-session-a" });
    assert.doesNotMatch(withSession, /publishes no session identity/);
    // The host key stands in for COPILOT_LOADER_PID, which is enough on its own:
    // it names the pointer file both halves share.
    const withKey = await cli(["status"]);
    assert.doesNotMatch(withKey, /publishes no session identity/);
  });
});

describe("a session id that cannot name a file", () => {
  it("is ignored, and says so instead of scoping somewhere else in silence", async () => {
    const run = (value) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(copilot, "neatcontext-cli.mjs"), "status"],
          {
            cwd: workspace,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...childEnv({}), NEATCONTEXT_SESSION_ID: value }
          }
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", () => resolve(stderr.trim()));
      });

    assert.match(await run("teams/payments"), /cannot name a session file/);
    assert.match(await run("../escape"), /cannot name a session file/);
    // The value itself is not echoed back: it is the user's, and the length is
    // enough to recognise which one they set.
    assert.doesNotMatch(await run("teams/payments"), /teams\/payments/);
    assert.equal(await run("payments-2"), "");
  });
});

describe("upgrading from a release that scoped to the workspace", () => {
  it("names the connection that workspace used to have", async () => {
    // Exactly what an earlier release left behind: a selection filed under the
    // workspace digest, with nothing under this session's id.
    await cli(["use", "payment team"], { cwd: workspace });
    const status = await cli(["status"], { sessionId: "copilot-session-new" });
    assert.match(status, /No context is connected/);
    assert.match(status, /An earlier version of this plugin connected "payment team"/);
    assert.match(status, /\/neatcontext:use payment team/);
  });

  it("says nothing once this session has its own connection", async () => {
    await cli(["use", "payment team"], { cwd: workspace });
    await cli(["use", "Dokploy"], { sessionId: "copilot-session-new" });
    const status = await cli(["status"], { sessionId: "copilot-session-new" });
    assert.doesNotMatch(status, /An earlier version of this plugin/);
  });

  it("says nothing when the workspace never had one", async () => {
    const status = await cli(["status"], { sessionId: "copilot-session-new" });
    assert.match(status, /No context is connected/);
    assert.doesNotMatch(status, /An earlier version of this plugin/);
  });
});

describe("telling the user when the bridge has not caught up", () => {
  it("warns after use when a live bridge is serving another session", async () => {
    await writeBridgeRecord("some-other-session");
    const output = await cli(["use", "payment team"], { sessionId: "copilot-session-a" });
    assert.match(output, /Connected the "payment team" context/);
    assert.match(output, /still serving an earlier session/);
  });

  it("says nothing when the bridge agrees", async () => {
    await writeBridgeRecord("copilot-session-a");
    const output = await cli(["use", "payment team"], { sessionId: "copilot-session-a" });
    assert.match(output, /Connected the "payment team" context/);
    assert.doesNotMatch(output, /still serving an earlier session/);
  });

  it("says nothing when no bridge is publishing at all", async () => {
    const output = await cli(["use", "payment team"], { sessionId: "copilot-session-a" });
    assert.match(output, /Connected the "payment team" context/);
    assert.doesNotMatch(output, /still serving an earlier session/);
  });

  it("says nothing when the bridge that published it has exited", async () => {
    // Above Linux's pid ceiling and not a multiple of four, which Windows pids
    // are: no platform can have handed this one out.
    await writeBridgeRecord("some-other-session", { pid: 2147483647 });
    const output = await cli(["use", "payment team"], { sessionId: "copilot-session-a" });
    assert.doesNotMatch(output, /still serving an earlier session/);
  });
});
