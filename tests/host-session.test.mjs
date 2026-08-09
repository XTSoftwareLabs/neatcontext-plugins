// The record that tells a long-lived plugin process which session its host is on
// now. Exercised directly here; the behavior it buys is in session-drift.test.mjs.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  awaitBridgeSession,
  bridgePointerPath,
  hostKey,
  hostPointerPath,
  hostsDirectory,
  isProcessAlive,
  normalizeHostSessionId,
  publishBridgeSession,
  pruneHostPointers,
  readBridgeSession,
  readHostPointer,
  resolveHostSessionId,
  writeHostPointer
} from "../plugins/claude-code/neatcontext/src/core/host-session.mjs";

// Above Linux's pid ceiling and not a multiple of four, which Windows pids are.
// No platform can have handed this one out.
const DEAD_PID = 2147483647;

let directory;
const saved = {};

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "neatcontext-host-session-"));
  for (const key of ["NEATCONTEXT_HOME", "NEATCONTEXT_HOST_KEY", "CLAUDE_PID"]) {
    saved[key] = process.env[key];
  }
  process.env.NEATCONTEXT_HOME = directory;
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.NEATCONTEXT_HOME = directory;
  process.env.NEATCONTEXT_HOST_KEY = "host-under-test";
  await rm(hostsDirectory(), { recursive: true, force: true });
});

describe("what counts as a session id", () => {
  it("accepts what a host actually issues", () => {
    assert.equal(
      normalizeHostSessionId(" 804e2a6b-0bfe-4632-9b85-ae9ad2d4242c "),
      "804e2a6b-0bfe-4632-9b85-ae9ad2d4242c"
    );
  });

  it("refuses anything that would not stay inside its own directory", () => {
    // This one arrives from a file rather than from the host, and it becomes a
    // path segment.
    for (const value of ["", "   ", ".", "..", "../elsewhere", "a/b", "a\\b", "\0", 7, null]) {
      assert.equal(normalizeHostSessionId(value), null, `accepted ${JSON.stringify(value)}`);
    }
  });

  it("refuses one longer than any host would issue", () => {
    assert.equal(normalizeHostSessionId("a".repeat(201)), null);
    assert.equal(normalizeHostSessionId("a".repeat(200)).length, 200);
  });
});

describe("which host process this is", () => {
  it("takes the explicit key when the host or a test supplies one", () => {
    process.env.NEATCONTEXT_HOST_KEY = "window-7";
    assert.equal(hostKey(), "window-7");
  });

  it("refuses an explicit key that is not a single path segment", () => {
    for (const value of ["", "  ", "..", "a/b", "a\\b"]) {
      process.env.NEATCONTEXT_HOST_KEY = value;
      assert.equal(hostKey(), null, `accepted ${JSON.stringify(value)}`);
    }
  });

  it("falls back to the host pid, which a slash command reads from its environment", () => {
    delete process.env.NEATCONTEXT_HOST_KEY;
    process.env.CLAUDE_PID = "48596";
    assert.equal(hostKey(), "pid-48596");
  });

  it("falls back to the parent process, which is the host for a server it spawned", () => {
    delete process.env.NEATCONTEXT_HOST_KEY;
    process.env.CLAUDE_PID = "not-a-pid";
    assert.equal(hostKey(), `pid-${process.ppid}`);
  });
});

describe("recording the session a host is on", () => {
  it("round-trips what was written", async () => {
    assert.equal(await writeHostPointer("session-a", { source: "stop" }), "session-a");
    const pointer = await readHostPointer();
    assert.equal(pointer.sessionId, "session-a");
    assert.equal(pointer.source, "stop");
    assert.equal(pointer.pid, process.pid);
  });

  it("records nothing when there is nothing to record", async () => {
    assert.equal(await writeHostPointer(""), null);
    assert.equal(await writeHostPointer(".."), null);
    process.env.NEATCONTEXT_HOST_KEY = "";
    assert.equal(await writeHostPointer("session-a"), null);
    assert.equal(await readHostPointer(), null);
  });

  it("reads nothing back from a record that is missing or broken", async () => {
    assert.equal(await readHostPointer(), null);
    await mkdir(hostsDirectory(), { recursive: true });
    await writeFile(hostPointerPath(hostKey()), "{ not json");
    assert.equal(await readHostPointer(), null);
    await writeFile(hostPointerPath(hostKey()), JSON.stringify({ sessionId: "../elsewhere" }));
    assert.equal(await readHostPointer(), null);
  });

  it("keeps working when the record cannot be written at all", async () => {
    // A directory that cannot exist, because a file is standing where it goes.
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "");
    process.env.NEATCONTEXT_HOME = blocked;
    assert.equal(await writeHostPointer("session-a"), null);
    assert.equal(await publishBridgeSession("session-a"), false);
  });
});

describe("the session a long-lived process should serve", () => {
  it("keeps what it started with when nothing has corrected it", async () => {
    assert.equal(await resolveHostSessionId("session-a"), "session-a");
  });

  it("keeps what it started with when the record agrees", async () => {
    await writeHostPointer("session-a");
    assert.equal(await resolveHostSessionId("session-a"), "session-a");
  });

  it("takes the record when it disagrees, because it was written later", async () => {
    await writeHostPointer("session-b");
    assert.equal(await resolveHostSessionId("session-a", { since: Date.now() - 60_000 }), "session-b");
  });

  it("ignores a disagreeing record older than the process reading it", async () => {
    // A pid gets reused. A record written before this process started cannot be
    // describing a change that happened after it.
    await mkdir(hostsDirectory(), { recursive: true });
    await writeFile(
      hostPointerPath(hostKey()),
      JSON.stringify({ sessionId: "session-b", updatedAt: "2001-01-01T00:00:00.000Z" })
    );
    assert.equal(await resolveHostSessionId("session-a", { since: Date.now() }), "session-a");
  });

  it("has no session to offer when the host named none", async () => {
    assert.equal(await resolveHostSessionId(undefined), null);
  });
});

describe("what the bridge publishes about itself", () => {
  it("writes when the answer changes and not when it does not", async () => {
    assert.equal(await publishBridgeSession("session-a"), true);
    assert.equal(await publishBridgeSession("session-a"), false);
    assert.equal(await publishBridgeSession("session-b"), true);
    assert.equal((await readBridgeSession()).sessionId, "session-b");
  });

  it("publishes nothing when it cannot tell which host it belongs to", async () => {
    process.env.NEATCONTEXT_HOST_KEY = "";
    assert.equal(await publishBridgeSession("session-c"), false);
    assert.equal(await readBridgeSession(), null);
    assert.deepEqual(await awaitBridgeSession("session-c"), { state: "unknown" });
  });

  it("is ignored once the process that wrote it is gone", async () => {
    await mkdir(hostsDirectory(), { recursive: true });
    await writeFile(
      bridgePointerPath(hostKey()),
      JSON.stringify({ pid: DEAD_PID, sessionId: "session-a" })
    );
    assert.equal(await readBridgeSession(), null);
    assert.deepEqual(await awaitBridgeSession("session-a"), { state: "unknown" });
  });

  it("reports a match without waiting", async () => {
    await publishBridgeSession("session-c");
    const { state } = await awaitBridgeSession("session-c", { timeoutMs: 0 });
    assert.equal(state, "matched");
  });

  it("reports drift once it has waited long enough for the answer to change", async () => {
    await publishBridgeSession("session-d");
    const { state, seen } = await awaitBridgeSession("session-e", {
      timeoutMs: 120,
      intervalMs: 20
    });
    assert.equal(state, "drifted");
    assert.equal(seen.sessionId, "session-d");
  });

  it("has nothing to check when there is no session to check for", async () => {
    assert.deepEqual(await awaitBridgeSession(null), { state: "unknown" });
  });
});

describe("sweeping up after hosts that have ended", () => {
  it("removes the records of dead processes and keeps everyone else's", async () => {
    process.env.NEATCONTEXT_HOST_KEY = `pid-${process.pid}`;
    await mkdir(hostsDirectory(), { recursive: true });
    const write = (name) =>
      writeFile(path.join(hostsDirectory(), name), JSON.stringify({ sessionId: "session-a" }));
    await write(`pid-${DEAD_PID}.json`);
    await write(`pid-${DEAD_PID}.bridge.json`);
    await write(`pid-${process.ppid}.json`);
    await write(`pid-${process.pid}.json`);
    await write("named-host.json");
    await write("not-a-record.txt");

    assert.equal(await pruneHostPointers(), 2);
    assert.deepEqual((await readdir(hostsDirectory())).sort(), [
      "named-host.json",
      "not-a-record.txt",
      `pid-${process.pid}.json`,
      `pid-${process.ppid}.json`
    ].sort());
  });

  it("has nothing to do when nothing has been recorded yet", async () => {
    assert.equal(await pruneHostPointers(), 0);
  });

  it("counts a process it may not signal as alive", () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(DEAD_PID), false);
  });
});
