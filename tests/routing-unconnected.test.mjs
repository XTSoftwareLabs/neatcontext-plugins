// A session grounded in nothing is the case routing exists for, and it was the
// one case that could not route.
//
// Two independent faults, both reproduced from a real GitHub Copilot session
// where a question about a saved incident context came back as an offer to run
// /neatcontext:use:
//
//   1. Every machine that had ever saved a context had "ask" written into
//      plugin-routing.json by a build whose default was ask. Auto became the
//      default in #77 and reached none of them, and reinstalling the plugin
//      does not help — that file lives in ~/.neatcontext and outlives any one
//      install.
//   2. The nothing-connected text led with a slash command, which is the first
//      and most imperative thing the model reads. It answered "what now?"
//      before the routing menu below it ever got a turn.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "copilot", "neatcontext");
const bridgeFile = path.join(plugin, "src", "copilot", "mcp-bridge.mjs");

let home;
let docs;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-unconnected-test-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "incident.md"), "# Incident\n");
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
});

// Every host ships its own copy of the core, kept byte-identical by
// `npm run sync:context`. The migration has to hold in all five: a user with
// Copilot and Claude Code installed has one ~/.neatcontext between them, and a
// copy that still read the baked-in "ask" would drag the other back.
const HOSTS = [
  ["Claude Code", "plugins/claude-code/neatcontext/src/core/routing.mjs"],
  ["GitHub Copilot", "plugins/copilot/neatcontext/src/core/routing.mjs"],
  ["Kimi Code", "plugins/kimi-code/neatcontext/src/core/routing.mjs"],
  ["pi", "plugins/pi/neatcontext/src/core/routing.mjs"],
  ["Codex", "codex-marketplace/plugins/neatcontext/src/core/routing.mjs"]
];

const cores = await Promise.all(
  HOSTS.map(async ([name, file]) => [name, await import(`../${file}`)])
);

const routing = await import("../plugins/copilot/neatcontext/src/core/routing.mjs");
const store = await import("../plugins/copilot/neatcontext/src/core/context-store.mjs");

const routingFile = () => path.join(home, "plugin-routing.json");
const readRoutingFile = async () => JSON.parse(await readFile(routingFile(), "utf8"));
const writeRoutingFile = (value) => writeFile(routingFile(), `${JSON.stringify(value, null, 2)}\n`, "utf8");

async function create(name, useWhen) {
  const { record, profileText } = await store.createContext({
    name,
    knowledgeFolder: docs,
    profile: `# ${name}\n\n## Purpose\n${useWhen}`
  });
  await routing.putCard(record.id, { useWhen, source: profileText });
  return record;
}

function bridge(sessionId = "unconnected-bridge") {
  const child = spawn(process.execPath, [bridgeFile], {
    env: { ...process.env, NEATCONTEXT_SESSION_ID: sessionId, NEATCONTEXT_HOME: home },
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

for (const [host, core] of cores) {
  describe(`a mode nobody chose (${host})`, () => {
    it("does not get written down, so a later default can still reach this machine", async () => {
      // Any routing write at all — deriving a card is the common one.
      await create("Incident", "checkout 5xx");
      const file = await readRoutingFile();
      assert.equal(
        Object.hasOwn(file, "mode"),
        false,
        "an unchosen mode must stay out of the file entirely"
      );
      assert.equal(core.resolveMode(await core.readRouting(), "any-session"), core.DEFAULT_MODE);
    });

    it("is dropped from a schema 1 file, where it recorded the build's default", async () => {
      await writeRoutingFile({ schema: 1, mode: "ask", cards: {}, sessions: {}, decisions: [] });
      const state = await core.readRouting();
      assert.equal(state.mode, null, "a schema 1 ask is not evidence of a choice");
      assert.equal(core.resolveMode(state, "any-session"), "auto");
    });

    it("keeps manual from a schema 1 file, which was never anyone's default", async () => {
      await writeRoutingFile({ schema: 1, mode: "manual", cards: {}, sessions: {}, decisions: [] });
      assert.equal(core.resolveMode(await core.readRouting(), "any-session"), "manual");
    });
  });

  describe(`a mode somebody chose (${host})`, () => {
    it("survives, and is written down so it is never mistaken for a default again", async () => {
      await core.setMode("ask", { global: true, id: "chooser" });
      assert.equal((await readRoutingFile()).mode, "ask");
      assert.equal((await readRoutingFile()).schema, 2);

      // The migration must not run twice and undo the choice it just recorded.
      await create("Incident", "checkout 5xx");
      assert.equal(core.resolveMode(await core.readRouting(), "chooser"), "ask");
      assert.equal((await readRoutingFile()).mode, "ask");
    });

    it("still scopes to one session when that is what was asked for", async () => {
      await core.setMode("manual", { id: "one-window" });
      const state = await core.readRouting();
      assert.equal(core.resolveMode(state, "one-window"), "manual");
      assert.equal(core.resolveMode(state, "another-window"), core.DEFAULT_MODE);
    });
  });
}

describe("get_context with nothing connected", () => {
  const ask = (session, query) =>
    session
      .send("tools/call", { name: "get_context", arguments: query ? { query } : {} })
      .then((response) => response.result.content[0].text);

  it("routes itself rather than handing back a command to type", async () => {
    await create("Incident", "checkout-api 5xx from pgbouncer pool exhaustion");
    await create("Queue lag", "order-events partition lag");
    const session = bridge("routes-itself");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const text = await ask(session, "why is checkout-api throwing 5xx?");

      assert.match(text, /Connect the one this request belongs to with `use_context`/);
      assert.match(text, /do not ask the user to run a command/);
      // The regression itself: the old text opened by telling the model to send
      // the user to /neatcontext:use, and that is what it acted on.
      assert.doesNotMatch(
        text.split("## Contexts")[0],
        /\/neatcontext:use/,
        "the lead paragraph must not answer 'what now?' with a slash command"
      );
      assert.match(text, /Incident/);
    } finally {
      await session.close();
    }
  });

  it("is reachable on a machine upgraded from a pre-#77 routing file", async () => {
    await create("Incident", "checkout-api 5xx from pgbouncer pool exhaustion");
    const state = await readRoutingFile();
    await writeRoutingFile({ ...state, schema: 1, mode: "ask" });

    const session = bridge("upgraded-machine");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      assert.match(await ask(session, "checkout-api 5xx"), /Routing is on \(auto\)/);

      // And the switch it was told to make actually goes through, unprompted,
      // which is what the baked-in ask was refusing.
      const used = await session.send("tools/call", {
        name: "use_context",
        arguments: { context: "Incident", reason: "checkout 5xx" }
      });
      assert.equal(used.result.isError, false);
      assert.match(used.result.content[0].text, /Switched this session to "Incident"/);
    } finally {
      await session.close();
    }
  });

  it("asks first when the user has genuinely chosen ask", async () => {
    await create("Incident", "checkout-api 5xx from pgbouncer pool exhaustion");
    await routing.setMode("ask", { global: true, id: "deliberate-asker" });
    const session = bridge("deliberate-asker");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const text = await ask(session, "checkout-api 5xx");
      assert.match(text, /Routing is in ask mode/);
      assert.match(text, /ask whether to connect it rather than connecting first/);
      assert.doesNotMatch(text, /Connect the one this request belongs to with `use_context`/);
    } finally {
      await session.close();
    }
  });

  it("falls back to the commands in manual mode, where there is no menu to follow", async () => {
    await create("Incident", "checkout-api 5xx from pgbouncer pool exhaustion");
    await routing.setMode("manual", { global: true, id: "manual-user" });
    const session = bridge("manual-user");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const text = await ask(session, "checkout-api 5xx");
      assert.match(text, /Connect one with `\/neatcontext:use`/);
      assert.doesNotMatch(text, /## Contexts/);
    } finally {
      await session.close();
    }
  });

  it("still leads with save when the store is empty", async () => {
    const session = bridge("empty-store");
    try {
      await session.send("initialize", { protocolVersion: "2025-11-25" });
      const text = await ask(session, "checkout-api 5xx");
      assert.match(text, /nothing to list/);
      assert.match(text, /\/neatcontext:save/);
    } finally {
      await session.close();
    }
  });
});
