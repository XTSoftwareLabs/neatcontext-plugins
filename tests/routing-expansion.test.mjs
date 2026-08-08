// The questions a context should catch, and the names inside it.
//
// This is the recall half of routing. A description answers "what is this?",
// which is not how anyone searches — they search with the words of their
// problem. These two lists hold that other vocabulary, are matched against, and
// are never shown to anyone.
//
// They live in the bundle rather than in this machine's routing cache on
// purpose: a context handed to a teammate has to be findable by the same words
// on their machine as on yours, without them rediscovering any of it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

let home;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-expansion-test-"));
  await mkdir(path.join(home, "docs"), { recursive: true });
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
});

const store = await import("../plugins/claude-code/neatcontext/src/core/context-store.mjs");
const { createRoutingIndex } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs"
);

const INCIDENT = {
  name: "Pool limits June",
  profile: "# Pool limits June\n\n## Purpose\nThe incident.\n",
  routingDescription: "billing-postgres default_pool_size regression after the June deploy",
  routingQuestions: [
    "why was checkout throwing 5xx last week",
    "did we ever fix that database timeout thing",
    "what happened on the thirtieth"
  ],
  routingEntities: ["INC-1001", "checkout-api", "pgbouncer", "dep-9001"],
  knowledge: [{ path: "session-summary.md", content: "# Summary\n\nPool exhaustion.\n" }]
};

async function manifestOf(record) {
  return JSON.parse(await readFile(path.join(record.directory, "context.json"), "utf8"));
}

describe("storing the matching material", () => {
  it("keeps questions and entities in the bundle", async () => {
    const { record } = await store.createCapturedContext(INCIDENT);
    const manifest = await manifestOf(record);
    assert.deepEqual(manifest.routingQuestions, INCIDENT.routingQuestions);
    assert.deepEqual(manifest.routingEntities, INCIDENT.routingEntities);
    assert.deepEqual(record.routingQuestions, INCIDENT.routingQuestions);
  });

  it("leaves the fields off entirely when there are none", async () => {
    // A manifest should not carry a field that says only that a host did not
    // fill it in.
    const { record } = await store.createCapturedContext({
      ...INCIDENT,
      routingQuestions: undefined,
      routingEntities: undefined
    });
    const manifest = await manifestOf(record);
    assert.equal("routingQuestions" in manifest, false);
    assert.equal("routingEntities" in manifest, false);
    assert.deepEqual(record.routingQuestions, []);
  });

  it("tidies what it is given", async () => {
    const { record } = await store.createCapturedContext({
      ...INCIDENT,
      routingQuestions: ["  spaced   out  ", "", "Spaced Out", 42, "kept"],
      routingEntities: ["INC-1001", "inc-1001", "  "]
    });
    // Trimmed, de-duplicated case-insensitively, non-strings dropped.
    assert.deepEqual(record.routingQuestions, ["spaced out", "kept"]);
    assert.deepEqual(record.routingEntities, ["INC-1001"]);
  });

  it("ignores a field that is not a list at all", async () => {
    const { record } = await store.createCapturedContext({
      ...INCIDENT,
      routingQuestions: "not a list"
    });
    assert.deepEqual(record.routingQuestions, []);
  });

  it("caps how much it will keep", async () => {
    const many = Array.from({ length: 60 }, (_, index) => `question number ${index}`);
    const { record } = await store.createCapturedContext({ ...INCIDENT, routingQuestions: many });
    assert.equal(record.routingQuestions.length, 20);
  });
});

describe("updating a context", () => {
  it("replaces the material when the save supplies it", async () => {
    const { record } = await store.createCapturedContext(INCIDENT);
    const baseHash = await store.fingerprintContext(record);
    const updated = await store.updateCapturedContext({
      targetId: record.id,
      baseHash,
      name: record.name,
      profile: "# Pool limits June\n\n## Purpose\nThe incident, revisited.\n",
      routingDescription: INCIDENT.routingDescription,
      routingQuestions: ["one new question"],
      routingEntities: ["INC-2002"],
      knowledge: INCIDENT.knowledge
    });
    assert.deepEqual(updated.record.routingQuestions, ["one new question"]);
    assert.deepEqual(updated.record.routingEntities, ["INC-2002"]);
  });

  it("leaves the material alone when the save says nothing about it", async () => {
    // A host that does not generate these must not silently strip what another
    // host wrote — the same rule extensions already follow.
    const { record } = await store.createCapturedContext(INCIDENT);
    const baseHash = await store.fingerprintContext(record);
    const updated = await store.updateCapturedContext({
      targetId: record.id,
      baseHash,
      name: record.name,
      profile: "# Pool limits June\n\n## Purpose\nUntouched material.\n",
      routingDescription: INCIDENT.routingDescription,
      knowledge: INCIDENT.knowledge
    });
    assert.deepEqual(updated.record.routingQuestions, INCIDENT.routingQuestions);
    assert.deepEqual(updated.record.routingEntities, INCIDENT.routingEntities);
  });

  it("counts a change to the material as a routing change", async () => {
    const { record } = await store.createCapturedContext(INCIDENT);
    const baseHash = await store.fingerprintContext(record);
    const preview = await store.previewCapturedContextUpdate({
      targetId: record.id,
      baseHash,
      name: record.name,
      profile: await readFile(record.profilePath, "utf8"),
      routingDescription: INCIDENT.routingDescription,
      routingQuestions: ["a question nobody asked before"],
      knowledge: INCIDENT.knowledge
    });
    assert.equal(preview.routingChanged, true);
    assert.equal(preview.changed, true);
  });
});

describe("what it buys", () => {
  // The point of the whole feature: a question phrased in the user's words,
  // sharing nothing with the description, still finds the context.
  const OTHERS = [
    ["Queue lag", "order-events partition lag and consumer rebalancing"],
    ["Codex design", "Codex CLI plugin design and marketplace packaging"],
    ["Kimi plugin", "Kimi Code manifests, skills and commands"],
    ["Evidence", "conversation evidence and transcript adapters"],
    ["Refunds", "refunds and chargebacks"],
    ["Docker container", "Ubuntu container with SSH"],
    ["Marketplace config", "switching the marketplace source"],
    ["Session drift", "bridge session and thread drift"]
  ];

  async function seed(incident) {
    await store.createCapturedContext(incident);
    for (const [name, routingDescription] of OTHERS) {
      await store.createCapturedContext({
        name,
        profile: `# ${name}\n\n## Purpose\n${routingDescription}\n`,
        routingDescription,
        knowledge: [{ path: "session-summary.md", content: `# ${name}\n` }]
      });
    }
    const contexts = await store.listContexts();
    const candidates = createRoutingIndex({ listFiles: () => Promise.resolve([]) });
    return (query) => candidates(contexts, { cards: {} }, query, { limit: 3 });
  }

  it("finds the context from words its description never uses", async () => {
    const rank = await seed(INCIDENT);
    const [top] = await rank("why was checkout throwing 5xx last week");
    assert.equal(top.name, "Pool limits June");
  });

  it("finds it from a ticket id that appears nowhere else", async () => {
    const rank = await seed(INCIDENT);
    const [top] = await rank("anything on dep-9001?");
    assert.equal(top.name, "Pool limits June");
  });

  it("does not find it without the material", async () => {
    // The same corpus and the same question, minus the stored questions: this
    // is the recall failure the feature exists to fix.
    const rank = await seed({
      ...INCIDENT,
      routingQuestions: undefined,
      routingEntities: undefined
    });
    const results = await rank("why was checkout throwing 5xx last week");
    assert.ok(!results.some((result) => result.name === "Pool limits June"));
  });
});
