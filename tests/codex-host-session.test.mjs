// The record that tells a long-lived plugin process which session its host is on
// now. This is the Codex copy of the module — same mechanism as the Claude Code
// one, but its host key has no CLAUDE_PID equivalent to consult, only the
// explicit key and the parent process.
//
// Codex itself no longer routes through it: its hooks and its MCP server are
// spawned from different parents, so the two never shared a key, and
// tests/codex-session-scope.test.mjs holds the plugin to one scope instead. What
// the Codex bundle still calls is `pruneHostPointers`, which clears the files
// older versions of the plugin left behind.

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
} from "../codex-marketplace/plugins/neatcontext/src/core/host-session.mjs";

// Above Linux's pid ceiling and not a multiple of four, which Windows pids are.
// No platform can have handed this one out.
const DEAD_PID = 2147483647;

let directory;
const saved = {};

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-host-"));
  for (const key of ["NEATCONTEXT_HOME", "NEATCONTEXT_HOST_KEY"]) {
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

describe("what counts as a thread id", () => {
  it("accepts what the host actually issues", () => {
    assert.equal(
      normalizeHostSessionId(" 019823e1-c04c-7e22-91e2-171d0f3e0b83 "),
      "019823e1-c04c-7e22-91e2-171d0f3e0b83"
    );
  });

  it("refuses anything that would not stay inside its own directory", () => {
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

  it("falls back to the parent process, which is the host for a directly spawned child", () => {
    delete process.env.NEATCONTEXT_HOST_KEY;
    assert.equal(hostKey(), `pid-${process.ppid}`);
  });
});

describe("recording the thread a host is on", () => {
  it("round-trips what was written", async () => {
    assert.equal(await writeHostPointer("thread-a", { source: "session-start" }), "thread-a");
    const pointer = await readHostPointer();
    assert.equal(pointer.sessionId, "thread-a");
    assert.equal(pointer.source, "session-start");
    assert.equal(pointer.pid, process.pid);
  });

  it("records nothing when there is nothing to record", async () => {
    assert.equal(await writeHostPointer(""), null);
    assert.equal(await writeHostPointer(".."), null);
    process.env.NEATCONTEXT_HOST_KEY = "";
    assert.equal(await writeHostPointer("thread-a"), null);
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
    assert.equal(await writeHostPointer("thread-a"), null);
    assert.equal(await publishBridgeSession("thread-a"), false);
  });
});

describe("the thread a long-lived process should serve", () => {
  it("keeps what it started with when nothing has corrected it", async () => {
    assert.equal(await resolveHostSessionId("thread-a"), "thread-a");
  });

  it("keeps what it started with when the record agrees", async () => {
    await writeHostPointer("thread-a");
    assert.equal(await resolveHostSessionId("thread-a"), "thread-a");
  });

  it("takes the record when it disagrees, because it was written later", async () => {
    await writeHostPointer("thread-b");
    assert.equal(await resolveHostSessionId("thread-a", { since: Date.now() - 60_000 }), "thread-b");
  });

  it("ignores a disagreeing record older than the process reading it", async () => {
    await mkdir(hostsDirectory(), { recursive: true });
    await writeFile(
      hostPointerPath(hostKey()),
      JSON.stringify({ sessionId: "thread-b", updatedAt: "2001-01-01T00:00:00.000Z" })
    );
    assert.equal(await resolveHostSessionId("thread-a", { since: Date.now() }), "thread-a");
  });

  it("has no thread to offer when the host named none", async () => {
    assert.equal(await resolveHostSessionId(undefined), null);
  });
});

describe("what the bridge publishes about itself", () => {
  it("writes when the answer changes and not when it does not", async () => {
    assert.equal(await publishBridgeSession("thread-a"), true);
    assert.equal(await publishBridgeSession("thread-a"), false);
    assert.equal(await publishBridgeSession("thread-b"), true);
    assert.equal((await readBridgeSession()).sessionId, "thread-b");
  });

  it("publishes nothing when it cannot tell which host it belongs to", async () => {
    process.env.NEATCONTEXT_HOST_KEY = "";
    assert.equal(await publishBridgeSession("thread-c"), false);
    assert.equal(await readBridgeSession(), null);
    assert.deepEqual(await awaitBridgeSession("thread-c"), { state: "unknown" });
  });

  it("is ignored once the process that wrote it is gone", async () => {
    await mkdir(hostsDirectory(), { recursive: true });
    await writeFile(
      bridgePointerPath(hostKey()),
      JSON.stringify({ pid: DEAD_PID, sessionId: "thread-a" })
    );
    assert.equal(await readBridgeSession(), null);
    assert.deepEqual(await awaitBridgeSession("thread-a"), { state: "unknown" });
  });

  it("reports a match without waiting", async () => {
    await publishBridgeSession("thread-c");
    const { state } = await awaitBridgeSession("thread-c", { timeoutMs: 0 });
    assert.equal(state, "matched");
  });

  it("reports drift once it has waited long enough for the answer to change", async () => {
    await publishBridgeSession("thread-d");
    const { state, seen } = await awaitBridgeSession("thread-e", {
      timeoutMs: 120,
      intervalMs: 20
    });
    assert.equal(state, "drifted");
    assert.equal(seen.sessionId, "thread-d");
  });

  it("has nothing to check when there is no thread to check for", async () => {
    assert.deepEqual(await awaitBridgeSession(null), { state: "unknown" });
  });
});

describe("sweeping up after hosts that have ended", () => {
  it("removes the records of dead processes and keeps everyone else's", async () => {
    process.env.NEATCONTEXT_HOST_KEY = `pid-${process.pid}`;
    await mkdir(hostsDirectory(), { recursive: true });
    const write = (name) =>
      writeFile(path.join(hostsDirectory(), name), JSON.stringify({ sessionId: "thread-a" }));
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
