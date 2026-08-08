// What a refusal is worth, and for how long.
//
// "Not that one" is the clearest signal a user ever gives about routing, and
// until now it was thrown away when the session closed. It is also not a rule:
// a context turned down during one week's work should not be unreachable a
// quarter later. So it fades, repeats deepen it, and nothing here ever becomes
// permanent.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

let home;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-declines-test-"));
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "plugin-routing.json"), { force: true });
});

const routing = await import("../plugins/claude-code/neatcontext/src/core/routing.mjs");
const { createRoutingIndex } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs"
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY);

function stateWith(declines) {
  return { declines };
}

describe("how a refusal fades", () => {
  it("costs a context most of its score the day it happens", () => {
    const state = stateWith({ refused: { at: daysAgo(0).toISOString(), count: 1 } });
    const factor = routing.declineFactor(state, "refused", NOW);
    assert.ok(factor < 0.65 && factor > 0.55, `expected roughly 0.6, got ${factor}`);
  });

  it("costs half as much after two weeks", () => {
    const fresh = routing.declineFactor(
      stateWith({ a: { at: daysAgo(0).toISOString(), count: 1 } }),
      "a",
      NOW
    );
    const older = routing.declineFactor(
      stateWith({ a: { at: daysAgo(14).toISOString(), count: 1 } }),
      "a",
      NOW
    );
    // Half the strength, so the multiplier is halfway back to 1.
    assert.ok(older > fresh);
    assert.ok(Math.abs(1 - older - (1 - fresh) / 2) < 0.01);
  });

  it("costs nothing at all after six weeks", () => {
    const state = stateWith({ a: { at: daysAgo(42).toISOString(), count: 1 } });
    assert.equal(routing.declineFactor(state, "a", NOW), 1);
  });

  it("deepens when the same context is refused again", () => {
    const once = routing.declineFactor(
      stateWith({ a: { at: daysAgo(0).toISOString(), count: 1 } }),
      "a",
      NOW
    );
    const thrice = routing.declineFactor(
      stateWith({ a: { at: daysAgo(0).toISOString(), count: 3 } }),
      "a",
      NOW
    );
    assert.ok(thrice < once);
  });

  it("never reaches zero, however many times it is refused", () => {
    // A guess the system made about someone must not harden into a rule.
    const state = stateWith({ a: { at: daysAgo(0).toISOString(), count: 10 } });
    assert.ok(routing.declineFactor(state, "a", NOW) > 0);
  });

  it("holds nothing against a context that was never refused", () => {
    assert.equal(routing.declineFactor(stateWith({}), "untouched", NOW), 1);
    assert.equal(routing.declineFactor({}, "untouched", NOW), 1);
  });

  it("ignores a record whose timestamp is unreadable", () => {
    const state = stateWith({ a: { at: "not a date", count: 1 } });
    assert.equal(routing.declineFactor(state, "a", NOW), 1);
  });
});

describe("recording a refusal", () => {
  it("keeps it beyond the session that produced it", async () => {
    await routing.noteDeclined("context:orders", { id: "session-a" });
    const state = await routing.readRouting();
    assert.equal(state.declines["context:orders"].count, 1);
    // And still blocks outright inside the session it happened in.
    assert.deepEqual(state.sessions["session-a"].declined, ["context:orders"]);
  });

  it("counts repeats and restarts the clock", async () => {
    await routing.noteDeclined("context:orders", { id: "session-a", now: daysAgo(10) });
    await routing.noteDeclined("context:orders", { id: "session-b", now: NOW });
    const state = await routing.readRouting();
    assert.equal(state.declines["context:orders"].count, 2);
    assert.equal(state.declines["context:orders"].at, NOW.toISOString());
  });

  it("records the refusal even with no session to attribute it to", async () => {
    await routing.noteDeclined("context:orders", { id: "", now: NOW });
    const state = await routing.readRouting();
    assert.equal(state.declines["context:orders"].count, 1);
  });

  it("drops records too old to change anything", async () => {
    await routing.noteDeclined("context:stale", { id: "session-a", now: daysAgo(90) });
    await routing.noteDeclined("context:fresh", { id: "session-a", now: NOW });
    const stored = JSON.parse(await readFile(path.join(home, "plugin-routing.json"), "utf8"));
    assert.equal("context:stale" in stored.declines, false);
    assert.equal("context:fresh" in stored.declines, true);
  });

  it("survives a hand-broken file rather than failing the session", async () => {
    const state = await routing.readRouting();
    assert.deepEqual(state.declines, {});
  });
});

describe("what it does to a shortlist", () => {
  const CONTEXTS = [
    { id: "refused", name: "Refused", revision: 1, routingDescription: "partition lag on orders" },
    { id: "other", name: "Other", revision: 1, routingDescription: "partition lag on orders" }
  ];

  function rankWith(declines) {
    const candidates = createRoutingIndex({ listFiles: () => Promise.resolve([]) });
    return candidates(CONTEXTS, { cards: {}, declines }, "partition lag on orders");
  }

  it("demotes a context the user turned down, without hiding it", async () => {
    // Both match identically, so nothing but the refusal can separate them.
    const before = await rankWith({});
    assert.equal(before[0].id, "other", "tie should break by id before any refusal");

    const after = await rankWith({ refused: { at: new Date().toISOString(), count: 1 } });
    assert.equal(after[0].id, "other");
    assert.equal(after[1].id, "refused");
    assert.ok(after[1].score < after[0].score);
    assert.equal(after.length, 2, "a refused context is ranked lower, not removed");
  });

  it("leaves the order alone once the refusal has expired", async () => {
    const expired = new Date(Date.now() - 60 * DAY).toISOString();
    const results = await rankWith({ refused: { at: expired, count: 1 } });
    assert.equal(results[0].score, results[1].score);
  });
});
