// Two hints that are about you rather than about the question.
//
// How often you use a context, and whether you are already on it. Both are read
// from what this machine has done, and neither writes anything to a bundle — a
// context stays exactly as portable as it was. Two people simply reach it in a
// slightly different order, which is the honest answer when one of them lives
// in it and the other has never opened it.
//
// Deliberately absent: anything tying a context to a folder or a repository. A
// context is not about the directory someone happened to be sitting in, and
// anchoring it to one would make the same shared context behave differently for
// teammates with different layouts.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let home;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-familiarity-test-"));
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

const routing = await import("../plugins/claude-code/neatcontext/src/core/routing.mjs");
const { createRoutingIndex } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs"
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

const ORDERS = { id: "orders", name: "Orders" };
const QUEUE = { id: "queue", name: "Queue" };

function stateWith(decisions = []) {
  return { decisions, declines: {}, cards: {} };
}

describe("how often you use a context", () => {
  it("counts for nothing when you never have", () => {
    assert.equal(routing.familiarity(stateWith(), ORDERS, { now: NOW }), 1);
  });

  it("helps a context you keep coming back to", () => {
    const once = routing.familiarity(
      stateWith([{ at: daysAgo(1), to: "Orders" }]),
      ORDERS,
      { now: NOW }
    );
    const often = routing.familiarity(
      stateWith([
        { at: daysAgo(1), to: "Orders" },
        { at: daysAgo(2), to: "Orders" },
        { at: daysAgo(3), to: "Orders" }
      ]),
      ORDERS,
      { now: NOW }
    );
    assert.ok(once > 1);
    assert.ok(often > once);
  });

  it("forgets slowly, so last month counts for less than last week", () => {
    const recent = routing.familiarity(stateWith([{ at: daysAgo(2), to: "Orders" }]), ORDERS, {
      now: NOW
    });
    const old = routing.familiarity(stateWith([{ at: daysAgo(40), to: "Orders" }]), ORDERS, {
      now: NOW
    });
    assert.ok(recent > old);
    assert.ok(old > 1);
  });

  it("stays a hint, never a decision", () => {
    // Fifty uses must not let a context run away with the ranking: the words
    // asked for decide, and this only leans.
    const heavy = stateWith(
      Array.from({ length: 50 }, () => ({ at: daysAgo(1), to: "Orders" }))
    );
    assert.ok(routing.familiarity(heavy, ORDERS, { now: NOW }) <= 1.25);
  });

  it("credits only the context that was actually chosen", () => {
    const state = stateWith([{ at: daysAgo(1), to: "Orders" }]);
    assert.equal(routing.familiarity(state, QUEUE, { now: NOW }), 1);
  });

  it("ignores entries it cannot read", () => {
    const state = stateWith([
      { at: "not a date", to: "Orders" },
      { at: daysAgo(-5), to: "Orders" },
      { to: "Orders" },
      null
    ]);
    assert.equal(routing.familiarity(state, ORDERS, { now: NOW }), 1);
  });

  it("copes with a state that has no history at all", () => {
    assert.equal(routing.familiarity({}, ORDERS, { now: NOW }), 1);
  });
});

describe("staying where you are", () => {
  it("gives the connected context a head start", () => {
    const connected = routing.familiarity(stateWith(), ORDERS, {
      connectedId: "orders",
      now: NOW
    });
    assert.ok(connected > 1);
  });

  it("gives it to the connected one only", () => {
    const state = stateWith();
    assert.equal(routing.familiarity(state, QUEUE, { connectedId: "orders", now: NOW }), 1);
  });
});

describe("what it does to a shortlist", () => {
  const CONTEXTS = [
    { id: "orders", name: "Orders", revision: 1, routingDescription: "partition lag on the stream" },
    { id: "queue", name: "Queue", revision: 1, routingDescription: "partition lag on the stream" }
  ];

  function rankWith(state, options) {
    const candidates = createRoutingIndex({ listFiles: () => Promise.resolve([]) });
    return candidates(CONTEXTS, state, "partition lag on the stream", options);
  }

  it("leaves an even match to the id, with no history to go on", async () => {
    const results = await rankWith(stateWith(), {});
    assert.equal(results[0].id, "orders");
    assert.equal(results[0].score, results[1].score);
  });

  it("puts the context you keep using first", async () => {
    const results = await rankWith(
      stateWith([
        { at: new Date().toISOString(), to: "Queue" },
        { at: new Date().toISOString(), to: "Queue" }
      ]),
      {}
    );
    assert.equal(results[0].id, "queue");
  });

  it("does not hand the session away from an equal match", async () => {
    // The incumbent wins a tie, which is the whole point: leaving is the
    // unusual move and should need more evidence than staying.
    const results = await rankWith(stateWith(), { connectedId: "queue" });
    assert.equal(results[0].id, "queue");
    assert.ok(results[0].score > results[1].score);
  });

  it("still loses to a context the request plainly names", async () => {
    // Staying put is a lean, not a lock. A request that names one of them by
    // its own words has to win, connected or not.
    const named = [
      { id: "orders", name: "Orders", revision: 1, routingDescription: "pgbouncer pool exhaustion" },
      { id: "queue", name: "Queue", revision: 1, routingDescription: "partition lag on the stream" }
    ];
    const candidates = createRoutingIndex({ listFiles: () => Promise.resolve([]) });
    const results = await candidates(named, stateWith(), "pgbouncer pool exhaustion", {
      connectedId: "queue"
    });
    assert.equal(results[0].id, "orders");
  });
});
