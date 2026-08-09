import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "claude-code", "neatcontext");
const cliFile = path.join(plugin, "src", "claude", "neatcontext-cli.mjs");
const bridgeFile = path.join(plugin, "src", "claude", "mcp-bridge.mjs");

let home;
let docs;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-routing-test-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "payments.md"), "# Payments\n");
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
});

const routing = await import("../plugins/claude-code/neatcontext/src/core/routing.mjs");
const selection = await import("../plugins/claude-code/neatcontext/src/core/selection.mjs");
const store = await import("../plugins/claude-code/neatcontext/src/core/context-store.mjs");
const localState = await import("../plugins/claude-code/neatcontext/src/core/local-state.mjs");
const storage = await import("../plugins/claude-code/neatcontext/src/core/storage-home.mjs");

async function create(name, useWhen) {
  const { record, profileText } = await store.createContext({
    name,
    knowledgeFolder: docs,
    profile: `# ${name}\n\n## Purpose\n${useWhen}`
  });
  await routing.putCard(record.id, { useWhen, source: profileText });
  return record;
}

describe("local state compatibility", () => {
  it("uses one home, lists local Contexts, and upgrades old selections", async () => {
    assert.equal(localState.sessionSelectionDirectory(), path.join(home, "plugin-sessions"));
    assert.deepEqual(await selection.listAllContexts(), { contexts: [] });

    const selectionFile = path.join(home, "plugin-selection.json");
    await writeFile(
      selectionFile,
      `${JSON.stringify({ liteContextId: "lite:old", contextName: "Old" })}\n`
    );
    assert.equal((await localState.readSelection()).contextId, "lite:old");
    assert.deepEqual(JSON.parse(await readFile(selectionFile, "utf8")), {
      schema: 2,
      contextId: "lite:old",
      contextName: "Old"
    });

    await writeFile(selectionFile, "{}\n");
    assert.equal(await localState.readSelection(), null);

    const override = process.env.NEATCONTEXT_HOME;
    try {
      delete process.env.NEATCONTEXT_HOME;
      assert.equal(storage.neatContextHome(), path.join(os.homedir(), ".neatcontext"));
    } finally {
      process.env.NEATCONTEXT_HOME = override;
    }
  });
});

function childEnv(sessionId = "routing-child") {
  return {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: sessionId,
    // A session here stands for a window, and a window is a host process of its
    // own: two sessions must no more share the record of which session their
    // host is on than they share a selection file.
    NEATCONTEXT_HOST_KEY: sessionId === "" ? "" : `host-${sessionId}`,
    CLAUDE_PID: "",
    NEATCONTEXT_HOME: home
  };
}

function cli(args, sessionId = "routing-child") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      env: childEnv(sessionId),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", () => resolve(output.trim()));
  });
}

function bridge(sessionId = "routing-bridge") {
  const child = spawn(process.execPath, [bridgeFile], {
    env: childEnv(sessionId),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true
  });
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  });
  let nextId = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      nextId += 1;
      waiters.set(nextId, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    send,
    close: async () => {
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
  };
}

describe("routing metadata", () => {
  it("renders one neutral Context menu and omits it in manual mode", async () => {
    const payments = await create("Payments", "payment failures and refunds");
    const orders = await create("Orders", "order fulfillment and shipping");
    await routing.addAlias(payments.id, "billing");
    const state = await routing.readRouting();
    const entries = routing.menuEntries([payments, orders], state);
    const menu = routing.renderMenu(entries, { connectedId: payments.id, mode: "ask" });
    assert.match(menu, /\*\*Payments\*\* \*\*\(connected\)\*\*/);
    assert.match(menu, /also called: billing/);
    assert.doesNotMatch(menu, /\(lite\)|\(standard\)/i);
    assert.equal(routing.renderMenu(entries, { mode: "manual" }), null);
  });

  it("tracks cards, aliases, decisions, and stale profile hashes", async () => {
    const record = await create("Payments", "payment failures");
    const state = await routing.readRouting();
    assert.equal(routing.isCardStale(state.cards[record.id], await store.readProfileText(record)), false);
    assert.equal(routing.isCardStale(state.cards[record.id], "changed profile"), true);
    await routing.noteDeclined(record.id, { id: "window-a" });
    await routing.noteDecision({ sessionId: "window-a", from: null, to: record.name });
    const updated = await routing.readRouting();
    assert.deepEqual(updated.sessions["window-a"].declined, [record.id]);
    assert.equal(updated.sessions["window-a"].switches, 1);
    assert.equal(updated.decisions.at(-1).to, "Payments");
  });

  it("enforces auto, ask, manual, declined, and already-connected policies", () => {
    const base = { mode: "ask", sessions: {} };
    assert.equal(
      routing.switchPolicy(base, { id: "a", targetId: "two", connectedId: "one" }).reason,
      "ask-first"
    );
    assert.equal(
      routing.switchPolicy(base, {
        id: "a",
        targetId: "two",
        connectedId: "one",
        requested: true
      }).allowed,
      true
    );
    assert.equal(
      routing.switchPolicy({ mode: "manual", sessions: {} }, {
        id: "a",
        targetId: "two",
        connectedId: "one"
      }).reason,
      "manual-mode"
    );
    assert.equal(
      routing.switchPolicy({ mode: "auto", sessions: { a: { declined: ["two"] } } }, {
        id: "a",
        targetId: "two",
        connectedId: "one"
      }).reason,
      "declined-this-session"
    );
    assert.equal(
      routing.switchPolicy(base, { id: "a", targetId: "one", connectedId: "one" }).reason,
      "already-connected"
    );
  });

  it("resolves by number, exact name, unique substring, and refuses ambiguity", () => {
    const contexts = [
      { id: "a", name: "Payment API" },
      { id: "b", name: "Payment Worker" },
      { id: "c", name: "Orders" }
    ];
    assert.equal(selection.resolveContext(contexts, "3").context.id, "c");
    assert.equal(selection.resolveContext(contexts, "orders").context.id, "c");
    assert.equal(selection.resolveContext(contexts, "worker").context.id, "b");
    assert.equal(selection.resolveContext(contexts, "payment").error, "ambiguous");
  });
});

describe("session routing", () => {
  it("keeps different sessions on different local Contexts", async () => {
    await create("Payments", "payment failures");
    await create("Orders", "order fulfillment");
    await cli(["use", "Payments"], "window-a");
    await cli(["use", "Orders"], "window-b");
    assert.match(await cli(["status"], "window-a"), /Connected context: Payments/);
    assert.match(await cli(["status"], "window-b"), /Connected context: Orders/);
  });

  it("asks before a routed switch and switches after explicit agreement", async () => {
    await create("Payments", "payment failures");
    await create("Orders", "order fulfillment");
    await cli(["use", "Payments"], "routing-bridge");
    // Set explicitly rather than assumed, so this keeps testing ask mode
    // whatever the default becomes.
    await cli(["mode", "ask"], "routing-bridge");
    const session = bridge();
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const refused = await session.send("tools/call", {
        name: "use_context",
        arguments: { context: "Orders", reason: "shipping request" }
      });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /ask mode/);
      const switched = await session.send("tools/call", {
        name: "use_context",
        arguments: { context: "Orders", requested: true, alias: "shipping" }
      });
      assert.match(switched.result.content[0].text, /Switched this session to "Orders"/);
      const grounded = await session.send("tools/call", {
        name: "get_context",
        arguments: {}
      });
      assert.match(grounded.result.content[0].text, /connected context: Orders/);
    } finally {
      await session.close();
    }
  });

  // Nothing connected is the case routing exists for, so the answer must lead
  // with the route the session can take itself. Leading with a slash command
  // there is what made routing look broken: it is the first thing the model
  // reads, and it answers "what now?" before the menu below gets a turn.
  it("tells an ungrounded session to connect a context itself", async () => {
    await create("Payments", "payment failures");
    await create("Orders", "order fulfillment");
    const session = bridge("ungrounded-window");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const answer = await session.send("tools/call", {
        name: "get_context",
        arguments: { query: "why are payments failing?" }
      });
      const text = answer.result.content[0].text;
      assert.match(text, /Connect the one this request belongs to with `use_context`/);
      assert.match(text, /do not ask the user to run a command/);
    } finally {
      await session.close();
    }
  });

  // Manual mode publishes no menu, so there is nothing to connect from and the
  // command really is the only way forward.
  it("falls back to the commands when routing is off", async () => {
    await create("Payments", "payment failures");
    await cli(["mode", "manual"], "manual-window");
    const session = bridge("manual-window");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const answer = await session.send("tools/call", {
        name: "get_context",
        arguments: { query: "why are payments failing?" }
      });
      const text = answer.result.content[0].text;
      assert.match(text, /Connect one with `\/neatcontext:use`/);
      assert.doesNotMatch(text, /## Contexts/);
    } finally {
      await session.close();
    }
  });

  it("previews a Context without changing the selection", async () => {
    await create("Payments", "payment failures");
    await create("Orders", "order fulfillment");
    await cli(["use", "Payments"], "routing-bridge");
    const session = bridge();
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const preview = await session.send("tools/call", {
        name: "preview_context",
        arguments: { context: "Orders" }
      });
      assert.match(preview.result.content[0].text, /# Orders/);
      assert.match(preview.result.content[0].text, /payments\.md/);
      assert.match(await cli(["status"], "routing-bridge"), /Connected context: Payments/);
    } finally {
      await session.close();
    }
  });

  it("tells the user which mode is the default and what each one does", async () => {
    const help = await cli(["mode"], "mode-help-session");
    assert.match(help, /Context routing is auto \(the default\)/);
    assert.match(help, /auto {4}switch context on a clear match.*\(default\)/);
    assert.match(help, /ask {5}always ask before switching$/m);
    assert.match(help, /manual {2}never route/);
  });
});
