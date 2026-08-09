// Narrowing the menu to what the request reached.
//
// The unit tests cover what the shortlist says; the bridge tests cover when it
// is used at all, which is the part with the risk in it. A shortlist that
// appears when it should not have is a session that can no longer see the
// context it needed.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "claude-code", "neatcontext");
const bridgeFile = path.join(plugin, "src", "claude", "mcp-bridge.mjs");

let home;
let docs;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-shortlist-test-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
});

const routing = await import("../plugins/claude-code/neatcontext/src/core/routing.mjs");
const store = await import("../plugins/claude-code/neatcontext/src/core/context-store.mjs");

async function create(name, useWhen) {
  const { record, profileText } = await store.createContext({
    name,
    knowledgeFolder: docs,
    profile: `# ${name}\n\n## Purpose\n${useWhen}`
  });
  await routing.putCard(record.id, { useWhen, source: profileText });
  return record;
}

function bridge(sessionId = "shortlist-bridge") {
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: sessionId,
      NEATCONTEXT_HOST_KEY: `host-${sessionId}`,
      CLAUDE_PID: "",
      NEATCONTEXT_HOME: home
    },
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

// Enough contexts to be over the floor at which narrowing is worth doing.
const CORPUS = [
  ["INC-1001 checkout pool exhaustion", "checkout-api 5xx from pgbouncer pool exhaustion"],
  ["Queue lag", "order-events partition lag and consumer rebalancing"],
  ["codex-neatcontext-design", "Codex CLI plugin design, marketplace packaging"],
  ["kimi-neatcontext-plugin", "Kimi Code manifests, skills and commands"],
  ["progressive-evidence-design", "conversation evidence and transcript adapters"],
  ["Refunds", "refunds and chargebacks"],
  ["Docker container", "Ubuntu container with SSH and the CLI installed"],
  ["Marketplace config", "switching the marketplace source between repo and folder"],
  ["Session drift", "MCP bridge session and thread drift across windows"]
];

async function seed() {
  const records = [];
  for (const [name, useWhen] of CORPUS) {
    records.push(await create(name, useWhen));
  }
  return records;
}

async function notesFor(client, args) {
  const response = await client.send("tools/call", {
    name: "get_context",
    ...(args ? { arguments: args } : {})
  });
  return response.result.content[0].text;
}

describe("renderShortlist", () => {
  const entries = [
    { id: "a", name: "Incident", useWhen: "checkout 5xx", aliases: [], matched: ["checkout", "5xx"] },
    { id: "b", name: "Queue", useWhen: "partition lag", aliases: [], matched: ["lag"] }
  ];

  it("lists matches in the order given, with why each matched", () => {
    const text = routing.renderShortlist(entries, { mode: "ask" });
    assert.match(text, /## Contexts that match what the user just asked/);
    assert.ok(text.indexOf("Incident") < text.indexOf("Queue"));
    assert.match(text, /_\(matched: checkout, 5xx\)_/);
  });

  it("says outright that others exist and did not match", () => {
    // Without this the short list reads like the whole store, and a model that
    // cannot find what it needs starts reaching for the nearest thing shown.
    assert.match(routing.renderShortlist(entries, { mode: "ask" }), /Others exist and did not match/);
  });

  it("carries the same routing rules as the full menu", () => {
    const text = routing.renderShortlist(entries, { mode: "ask", connectedId: "b" });
    assert.match(text, /Routing is on \(ask\)/);
    assert.match(text, /Do not route on follow-ups/);
    assert.match(text, /pass what they called it as `alias`/);
  });

  // The follow-up guard exists to make *leaving* a context cost something. With
  // nothing connected there is nowhere to leave from, and the same sentence
  // reads as a reason to do nothing at all — which is how a request that
  // plainly belonged to a saved context got answered from general knowledge.
  it("drops the follow-up guard when the session is grounded in nothing", () => {
    const text = routing.renderShortlist(entries, { mode: "auto" });
    assert.doesNotMatch(text, /Do not route on follow-ups/);
    assert.match(text, /nothing to leave/);
    assert.match(text, /connect it with the `use_context` tool/);
    assert.match(text, /do not ask the user to run a command/);
  });

  it("still asks first in ask mode when nothing is connected", () => {
    const text = routing.renderShortlist(entries, { mode: "ask" });
    assert.match(text, /Routing is on \(ask\)/);
    assert.match(text, /never connect first/);
  });

  it("uses the auto wording in auto mode", () => {
    assert.match(routing.renderShortlist(entries, { mode: "auto" }), /Routing is on \(auto\)/);
  });

  it("marks the connected context", () => {
    assert.match(routing.renderShortlist(entries, { mode: "ask", connectedId: "b" }), /\*\*Queue\*\* \*\*\(connected\)\*\*/);
  });

  it("omits the match note when there is nothing to report", () => {
    const text = routing.renderShortlist([{ id: "a", name: "Incident", useWhen: "checkout 5xx", aliases: [] }], {
      mode: "ask"
    });
    assert.ok(!text.includes("matched:"));
  });

  it("stays silent in manual mode and with nothing to show", () => {
    assert.equal(routing.renderShortlist(entries, { mode: "manual" }), null);
    assert.equal(routing.renderShortlist([], { mode: "ask" }), null);
  });
});

describe("get_context with a query", () => {
  it("advertises the query argument", async () => {
    const client = bridge();
    try {
      await client.send("initialize", {});
      const response = await client.send("tools/list", {});
      const tool = response.result.tools.find((entry) => entry.name === "get_context");
      assert.equal(tool.inputSchema.properties.query.type, "string");
    } finally {
      await client.close();
    }
  });

  it("narrows the menu to the contexts the request reached", async () => {
    await seed();
    const client = bridge();
    try {
      await client.send("initialize", {});
      const notes = await notesFor(client, { query: "why is checkout throwing 5xx" });
      assert.match(notes, /## Contexts that match what the user just asked/);
      assert.match(notes, /INC-1001 checkout pool exhaustion/);
      // The contexts that did not match are gone, which is the entire point.
      assert.ok(!notes.includes("kimi-neatcontext-plugin"));
      assert.ok(!notes.includes("Docker container"));
    } finally {
      await client.close();
    }
  });

  it("keeps the full menu when no query is passed", async () => {
    // Hosts that never send one must behave exactly as they do today.
    await seed();
    const client = bridge();
    try {
      await client.send("initialize", {});
      const notes = await notesFor(client);
      assert.match(notes, /## Contexts available on this machine/);
      assert.match(notes, /kimi-neatcontext-plugin/);
    } finally {
      await client.close();
    }
  });

  it("keeps the full menu when the query matches nothing", async () => {
    // Never show a session less than it has today just because a question was
    // phrased in words no context happens to use.
    await seed();
    const client = bridge();
    try {
      await client.send("initialize", {});
      const notes = await notesFor(client, { query: "what is the capital of France" });
      assert.match(notes, /## Contexts available on this machine/);
      assert.match(notes, /Docker container/);
    } finally {
      await client.close();
    }
  });

  it("keeps the full menu for an empty or whitespace query", async () => {
    await seed();
    const client = bridge();
    try {
      await client.send("initialize", {});
      assert.match(await notesFor(client, { query: "   " }), /## Contexts available on this machine/);
    } finally {
      await client.close();
    }
  });

  it("keeps the full menu when there are few enough contexts to read", async () => {
    // Narrowing a list of three would hide contexts to save nothing.
    await create("Payments", "payment failures and refunds");
    await create("Orders", "order fulfillment and shipping");
    await create("Queue", "order-events partition lag");
    const client = bridge();
    try {
      await client.send("initialize", {});
      const notes = await notesFor(client, { query: "payment failures" });
      assert.match(notes, /## Contexts available on this machine/);
      assert.match(notes, /Orders/);
    } finally {
      await client.close();
    }
  });

  it("still says how to connect a context", async () => {
    await seed();
    const client = bridge();
    try {
      await client.send("initialize", {});
      const notes = await notesFor(client, { query: "partition lag" });
      assert.match(notes, /## Connecting a context, in Claude Code/);
    } finally {
      await client.close();
    }
  });

  it("leaves the handshake showing everything", async () => {
    // There is no request to match against at initialize, so the full menu is
    // the only correct answer there.
    await seed();
    const client = bridge();
    try {
      const response = await client.send("initialize", {});
      assert.match(response.result.instructions, /## Contexts available on this machine/);
    } finally {
      await client.close();
    }
  });
});
