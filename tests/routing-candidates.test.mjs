// Turning contexts into something a question can be matched against.
//
// Two things are under test. The mechanical part — are the right fields built,
// is the index reused when nothing changed and rebuilt when something did — and
// the part that actually matters, which is whether questions phrased the way a
// user phrases them reach the context that should answer them. The last suite
// measures that as a rate rather than asserting one case at a time, because a
// router is only as good as its worst realistic question.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRoutingIndex,
  fingerprint,
  routingDocuments,
  routingFields
} from "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs";

function context(id, name, extra = {}) {
  return { id, name, revision: 1, updatedAt: "2026-08-08T00:00:00.000Z", ...extra };
}

function stateWith(cards = {}) {
  return { cards };
}

// A corpus with the shape that makes routing hard: a family of contexts about
// one project, two incidents that share vocabulary, and unrelated domains.
const CONTEXTS = [
  context("incident", "INC-1001 checkout-api pool exhaustion", {
    routingDescription:
      "checkout-api 5xx on 2026-06-30, billing-postgres pgbouncer pool exhaustion, hand-off to Infra"
  }),
  context("queue", "Queue lag", {
    routingDescription: "order-events partition lag and consumer rebalancing"
  }),
  context("codex", "codex-neatcontext-design", {
    routingDescription: "NeatContext Codex CLI plugin design, marketplace packaging, MCP bridge, PR 30"
  }),
  context("kimi", "kimi-neatcontext-plugin", {
    routingDescription: "NeatContext for Kimi Code: manifests, skills, commands, session binding, tests"
  }),
  context("evidence", "progressive-evidence-design", {
    routingDescription: "progressive conversation evidence, transcript adapters, sync:evidence, PR 52"
  }),
  context("refunds", "workspace scoped", {
    routingDescription: "refunds and chargebacks"
  })
];

const FILES = {
  incident: ["runbook.md", "timeline.md", "pgbouncer-settings.md"],
  queue: ["consumer-lag.md"],
  codex: ["packaging.md", "mcp-bridge.md"],
  kimi: ["install.md", "commands.md"],
  evidence: ["adapters.md"],
  refunds: ["chargeback-policy.md"]
};

function listFilesFor(record) {
  return Promise.resolve(FILES[record.id] ?? []);
}

describe("routingFields", () => {
  it("prefers the card line this machine derived over the one that travelled", () => {
    const fields = routingFields(
      context("id", "Name", { routingDescription: "from the bundle" }),
      { useWhen: "from this machine", aliases: [] },
      []
    );
    assert.equal(fields.description, "from this machine");
  });

  it("falls back to the manifest line when there is no card yet", () => {
    // A context a teammate handed over is routable before it is ever connected.
    const fields = routingFields(
      context("id", "Name", { routingDescription: "from the bundle" }),
      undefined,
      []
    );
    assert.equal(fields.description, "from the bundle");
  });

  it("joins aliases and filenames into searchable text", () => {
    const fields = routingFields(context("id", "Name"), { useWhen: "", aliases: ["the billing thing", "refunds"] }, [
      "policy.md",
      "runbook.md"
    ]);
    assert.equal(fields.aliases, "the billing thing refunds");
    assert.equal(fields.files, "policy.md runbook.md");
  });

  it("survives a context with nothing but a name", () => {
    const fields = routingFields({ id: "bare" }, undefined, []);
    assert.deepEqual(fields, { name: "", description: "", aliases: "", files: "" });
  });
});

describe("fingerprint", () => {
  it("is stable when nothing changed", () => {
    assert.equal(fingerprint(CONTEXTS, stateWith()), fingerprint(CONTEXTS, stateWith()));
  });

  it("changes when a context is edited", () => {
    const edited = CONTEXTS.map((entry) =>
      entry.id === "queue" ? { ...entry, revision: 2 } : entry
    );
    assert.notEqual(fingerprint(CONTEXTS, stateWith()), fingerprint(edited, stateWith()));
  });

  it("changes when a card gains an alias", () => {
    const before = fingerprint(CONTEXTS, stateWith());
    const after = fingerprint(
      CONTEXTS,
      stateWith({ queue: { useWhen: "", aliases: ["the lag thing"], updatedAt: "2026-08-09T00:00:00.000Z" } })
    );
    assert.notEqual(before, after);
  });

  it("changes when a context is added or removed", () => {
    assert.notEqual(fingerprint(CONTEXTS, stateWith()), fingerprint(CONTEXTS.slice(1), stateWith()));
  });
});

describe("routingDocuments", () => {
  it("builds one document per context, with its files", async () => {
    const documents = await routingDocuments(CONTEXTS, stateWith(), listFilesFor);
    assert.equal(documents.length, CONTEXTS.length);
    const incident = documents.find((document) => document.id === "incident");
    assert.ok(incident.fields.files.includes("pgbouncer-settings.md"));
  });
});

describe("createRoutingIndex", () => {
  it("finds the context a question belongs to and names it", async () => {
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    const [top] = await candidates(CONTEXTS, stateWith(), "pgbouncer pool exhaustion");
    assert.equal(top.id, "incident");
    assert.equal(top.name, "INC-1001 checkout-api pool exhaustion");
    assert.ok(top.matched.includes("pgbouncer"));
    assert.ok(top.score > 0);
  });

  it("reads the knowledge folders once and reuses the index", async () => {
    // The cache is the whole reason there is no index file, so it is worth
    // testing that it actually holds.
    let reads = 0;
    const candidates = createRoutingIndex({
      listFiles: (record) => {
        reads += 1;
        return listFilesFor(record);
      }
    });
    await candidates(CONTEXTS, stateWith(), "pgbouncer");
    assert.equal(reads, CONTEXTS.length);
    await candidates(CONTEXTS, stateWith(), "partition lag");
    assert.equal(reads, CONTEXTS.length);
  });

  it("rebuilds when a context changes", async () => {
    let reads = 0;
    const candidates = createRoutingIndex({
      listFiles: (record) => {
        reads += 1;
        return listFilesFor(record);
      }
    });
    await candidates(CONTEXTS, stateWith(), "pgbouncer");
    const edited = CONTEXTS.map((entry) =>
      entry.id === "refunds" ? { ...entry, revision: 2, routingDescription: "refunds, chargebacks, PAY-* tickets" } : entry
    );
    await candidates(edited, stateWith(), "pay-1234");
    assert.equal(reads, CONTEXTS.length * 2);
  });

  it("picks up a new alias without needing anything else to change", async () => {
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    // "billing" reaches the incident, which mentions billing-postgres. What it
    // does not reach is the context the user actually meant.
    const before = await candidates(CONTEXTS, stateWith(), "the billing thing");
    assert.ok(!before.some((result) => result.id === "refunds"));

    const corrected = stateWith({
      refunds: { useWhen: "", aliases: ["the billing thing"], updatedAt: "2026-08-09T00:00:00.000Z" }
    });
    const [top] = await candidates(CONTEXTS, corrected, "the billing thing");
    assert.equal(top.id, "refunds");
  });

  it("returns nothing when the question belongs to none of them", async () => {
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    assert.deepEqual(await candidates(CONTEXTS, stateWith(), "what is the capital of France"), []);
  });

  it("honours a limit", async () => {
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    const results = await candidates(CONTEXTS, stateWith(), "neatcontext plugin design", { limit: 2 });
    assert.equal(results.length, 2);
  });
});

// The measurement the design asks for before any ranking work: not "does this
// one case pass" but "what share of realistic questions reach the right
// context". Recall@3 is the ceiling on the whole design — the session's model
// can never choose a context that stage one did not hand it.
describe("recall over realistic questions", () => {
  const QUESTIONS = [
    ["why was checkout-api throwing 5xx", "incident"],
    ["pgbouncer pool exhaustion on billing-postgres", "incident"],
    ["INC-1001", "incident"],
    ["what happened on 2026-06-30", "incident"],
    ["order-events partition lag", "queue"],
    ["consumer rebalancing problem", "queue"],
    ["how do I package the codex plugin for the marketplace", "codex"],
    ["codex MCP bridge design", "codex"],
    ["kimi code manifests and skills", "kimi"],
    ["session binding for kimi", "kimi"],
    ["progressive conversation evidence adapters", "evidence"],
    ["sync:evidence transcript", "evidence"],
    ["refunds and chargebacks", "refunds"],
    ["chargeback policy", "refunds"]
  ];

  it("puts the right context in the top 3 for every question", async () => {
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    const missed = [];
    for (const [question, expected] of QUESTIONS) {
      const results = await candidates(CONTEXTS, stateWith(), question, { limit: 3 });
      if (!results.some((result) => result.id === expected)) {
        missed.push(question);
      }
    }
    assert.deepEqual(missed, [], `questions that missed the top 3: ${missed.join("; ")}`);
  });

  it("ranks the right context first for most questions", async () => {
    // Stage two exists precisely because stage one is not expected to be
    // perfect at rank 1. The bar here is that it usually is.
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    let first = 0;
    for (const [question, expected] of QUESTIONS) {
      const results = await candidates(CONTEXTS, stateWith(), question, { limit: 3 });
      if (results[0]?.id === expected) {
        first += 1;
      }
    }
    assert.ok(
      first / QUESTIONS.length >= 0.8,
      `ranked first for ${first}/${QUESTIONS.length}, which is below the 80% bar`
    );
  });

  it("stays quiet on questions that belong to no context", async () => {
    // The expensive mistake is switching when nothing matched, so the negative
    // set matters as much as the positive one.
    const candidates = createRoutingIndex({ listFiles: listFilesFor });
    for (const question of [
      "what is the weather tomorrow",
      "write me a haiku about the sea",
      "how do I centre a div"
    ]) {
      assert.deepEqual(await candidates(CONTEXTS, stateWith(), question), [], question);
    }
  });
});
