// Knowing when not to pick.
//
// Stage one produces a score, and the gap between the best candidate and the
// next one is the only measure of confidence this design has. It is not there
// to pick better — it is there to turn a near-tie into a question instead of a
// guess, because switching to the wrong context is far more expensive than
// asking which one was meant.

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
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-confidence-test-"));
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
const { CLOSE_RATIO, assess } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs"
);

async function create(name, useWhen) {
  const { record, profileText } = await store.createContext({
    name,
    knowledgeFolder: docs,
    profile: `# ${name}\n\n## Purpose\n${useWhen}`
  });
  await routing.putCard(record.id, { useWhen, source: profileText });
  return record;
}

function bridge(sessionId = "confidence-bridge") {
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

const candidate = (id, score) => ({ id, name: id, score });

describe("assess", () => {
  it("calls a clear leader clear", () => {
    const decision = assess([candidate("winner", 10), candidate("other", 2)]);
    assert.equal(decision.verdict, "clear");
    assert.deepEqual(
      decision.leaders.map((leader) => leader.id),
      ["winner"]
    );
  });

  it("calls a near-tie close, and names everyone in it", () => {
    const decision = assess([candidate("first", 10), candidate("second", 9.5)]);
    assert.equal(decision.verdict, "close");
    assert.deepEqual(
      decision.leaders.map((leader) => leader.id),
      ["first", "second"]
    );
  });

  it("includes every candidate inside the ratio, not just two", () => {
    const decision = assess([candidate("a", 10), candidate("b", 9.5), candidate("c", 9), candidate("d", 1)]);
    assert.deepEqual(
      decision.leaders.map((leader) => leader.id),
      ["a", "b", "c"]
    );
  });

  it("treats a lone candidate as clear", () => {
    assert.equal(assess([candidate("only", 0.4)]).verdict, "clear");
  });

  it("reports nothing to decide on an empty list", () => {
    const decision = assess([]);
    assert.equal(decision.verdict, "none");
    assert.deepEqual(decision.leaders, []);
  });

  it("puts the boundary where the ratio says", () => {
    // Exactly at the ratio is not close; a shade above it is.
    assert.equal(assess([candidate("a", 10), candidate("b", 10 * CLOSE_RATIO)]).verdict, "clear");
    assert.equal(assess([candidate("a", 10), candidate("b", 10 * CLOSE_RATIO + 0.01)]).verdict, "close");
  });
});

describe("renderShortlist with a decision", () => {
  const entries = [
    { id: "a", name: "Codex plugin", useWhen: "packaging", aliases: [], score: 10 },
    { id: "b", name: "Kimi plugin", useWhen: "packaging", aliases: [], score: 9.8 }
  ];

  it("asks rather than picks when two match equally", () => {
    const text = routing.renderShortlist(entries, { mode: "auto", decision: assess(entries) });
    assert.match(text, /\*\*Codex plugin\*\* and \*\*Kimi plugin\*\* match the request about equally well/);
    assert.match(text, /ask which/);
  });

  it("overrides auto explicitly, since auto is where the mistake would go unseen", () => {
    const text = routing.renderShortlist(entries, { mode: "auto", decision: assess(entries) });
    assert.match(text, /in auto mode too/);
    assert.match(text, /Switch only once they have answered/);
  });

  it("says nothing about ties when there is a clear leader", () => {
    const clear = [
      { id: "a", name: "Codex plugin", useWhen: "packaging", aliases: [], score: 10 },
      { id: "b", name: "Kimi plugin", useWhen: "packaging", aliases: [], score: 2 }
    ];
    const text = routing.renderShortlist(clear, { mode: "auto", decision: assess(clear) });
    assert.ok(!text.includes("about equally well"));
  });

  it("renders without a decision at all", () => {
    // The renderer keeps working for callers that have no scores to hand.
    assert.match(routing.renderShortlist(entries, { mode: "ask" }), /Contexts that match/);
  });
});

describe("the bridge decides from real scores", () => {
  // Two contexts described identically: nothing but the name separates them,
  // so a request about what they share is a genuine coin flip.
  async function seedTwins() {
    await create("Codex plugin packaging", "plugin packaging, manifests and marketplace steps");
    await create("Kimi plugin packaging", "plugin packaging, manifests and marketplace steps");
    await create("INC-1001 checkout", "checkout-api 5xx from pgbouncer pool exhaustion");
    await create("Queue lag", "order-events partition lag and consumer rebalancing");
    await create("Refunds", "refunds and chargebacks");
    await create("Docker container", "Ubuntu container with SSH");
    await create("Session drift", "MCP bridge session and thread drift");
    await create("Evidence", "conversation evidence and transcript adapters");
    await create("Marketplace config", "switching the marketplace source");
  }

  async function notesFor(query) {
    const client = bridge();
    try {
      await client.send("initialize", {});
      const response = await client.send("tools/call", {
        name: "get_context",
        arguments: { query }
      });
      return response.result.content[0].text;
    } finally {
      await client.close();
    }
  }

  it("asks which one when the request cannot separate two contexts", async () => {
    await seedTwins();
    const notes = await notesFor("manifests and marketplace steps");
    assert.match(notes, /match the request about equally well/);
    assert.match(notes, /Codex plugin packaging/);
    assert.match(notes, /Kimi plugin packaging/);
  });

  it("names a winner when the request does separate them", async () => {
    await seedTwins();
    const notes = await notesFor("pgbouncer pool exhaustion on checkout-api");
    assert.match(notes, /INC-1001 checkout/);
    assert.ok(!notes.includes("match the request about equally well"));
  });
});
