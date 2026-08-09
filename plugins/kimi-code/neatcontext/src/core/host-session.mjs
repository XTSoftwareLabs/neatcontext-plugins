// Which session the host process is on *right now*.
//
// A host that identifies its sessions through the environment has a problem the
// rest of this plugin cannot see: the environment is a snapshot. Hosts spawn the
// MCP bridge once and keep it for the life of the window, but the session
// changes underneath it — starting a fresh conversation does not restart the
// server — and the bridge's copy of the id is whatever it was at spawn. The
// hooks and the slash-command CLI are spawned fresh and see the new one.
//
// So the two halves of the plugin end up reading and writing different files:
// `use` writes the selection for the session the user is in, the bridge keeps
// serving the session the window started in, and nothing in either path can
// observe the disagreement. The user is told a context is connected and every
// later answer is grounded in a different one.
//
// This module is the missing channel. One pointer file per host *process*,
// written by whichever short-lived process was just handed the current session
// id, and re-read by the long-lived one on every message:
//
//   ~/.neatcontext/plugin-hosts/<hostKey>.json   { sessionId, source, updatedAt }
//
// The host key has to be stable across a session change and distinct per window,
// which rules out the session id and the working directory both. What is left is
// the host process itself. How to name it is the one thing that differs per
// host, so each adapter registers its own answer with `configureHostPid()`: some
// hosts publish their own pid to every process they spawn, and a host that
// publishes nothing falls back to `process.ppid`, which is the host for any
// process it spawned directly. A process whose parent is not the host and whose
// host publishes no pid — a CLI running inside a shell tool — computes a key
// nothing else reads, and its writes are harmless and swept later.
//
// The bridge also publishes what it actually resolved:
//
//   ~/.neatcontext/plugin-hosts/<hostKey>.bridge.json  { pid, sessionId, updatedAt }
//
// That is what lets `use` check its own success against the process that will
// serve it, instead of against the file it just wrote itself.

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { neatContextHome } from "./storage-home.mjs";

// A session id becomes a path segment (`plugin-sessions/<id>.json`), and unlike
// the environment — which only the host can set — this one arrives from a file.
// Anything that could climb out of the directory, or name the directory itself,
// is not a session id.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function normalizeHostSessionId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const id = value.trim();
  if (id === "." || id === ".." || !SAFE_SESSION_ID.test(id)) {
    return null;
  }
  return id;
}

function pidKey(value) {
  const pid = typeof value === "string" ? value.trim() : String(value ?? "");
  return /^[1-9][0-9]{0,9}$/.test(pid) ? `pid-${pid}` : null;
}

// Where the host publishes its own process id, when it publishes one at all.
//
// Deliberately per adapter rather than a list of every host's variable checked
// in turn: those variables are inherited by child processes, so a host launched
// from another host's shell would key on the outer host and two different hosts
// could end up sharing one pointer file. Each adapter consults only the variable
// its own host sets.
//
// Process-global, because one process runs one host's adapter. A test that
// imported two adapters into the same process would have the second silently
// win; there is no such test, and there should not be one.
let hostPidProvider = null;

export function configureHostPid(provider) {
  if (provider !== null && typeof provider !== "function") {
    throw new TypeError("The host pid provider must be a function or null.");
  }
  hostPidProvider = provider;
}

function hostPid() {
  if (!hostPidProvider) {
    return null;
  }
  // An adapter reading a value the host never set must not take down the only
  // path that can name this process's host.
  try {
    return hostPidProvider();
  } catch {
    return null;
  }
}

// A host key names one directory entry, so it is held to the same rule as
// anything else that becomes a path segment. Exported because an adapter that
// wants to know whether a shared key is available has to ask the same question
// this does — a value accepted there and rejected here would claim a channel
// that was never opened.
export function normalizeHostKey(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
    ? trimmed
    : null;
}

// The host process this process belongs to.
//
// NEATCONTEXT_HOST_KEY is the explicit form, for tests and for any host that can
// hand every one of its plugin processes the same identifier. Otherwise the pid
// the adapter knows how to find, and failing that `process.ppid`, which is the
// host for a server or hook it spawned directly.
export function hostKey() {
  const explicit = process.env.NEATCONTEXT_HOST_KEY;
  if (typeof explicit === "string") {
    return normalizeHostKey(explicit);
  }
  return pidKey(hostPid()) ?? pidKey(process.ppid);
}

export function hostsDirectory() {
  return path.join(neatContextHome(), "plugin-hosts");
}

export function hostPointerPath(key) {
  return path.join(hostsDirectory(), `${key}.json`);
}

export function bridgePointerPath(key) {
  return path.join(hostsDirectory(), `${key}.bridge.json`);
}

async function readPointer(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const id = normalizeHostSessionId(parsed?.sessionId);
    if (!id) {
      return null;
    }
    const updatedAt = Date.parse(parsed?.updatedAt);
    return {
      sessionId: id,
      source: typeof parsed?.source === "string" ? parsed.source : "unknown",
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
      pid: typeof parsed?.pid === "number" ? parsed.pid : null
    };
  } catch {
    // Missing, half-written, or hand-broken: the caller falls back to the
    // environment, which is exactly the behavior that predates this file.
    return null;
  }
}

let writeCounter = 0;

// Written to a temporary name and renamed into place, because these files are
// read by other processes while they are being written: the bridge re-reads the
// pointer on every message, and a reader that catches a half-written file falls
// back to the environment, which is the stale answer this file exists to
// correct. A rename is atomic, so a reader sees the old record or the new one.
//
// The temporary name carries this process's pid so that two processes writing
// the same pointer at once cannot collide on it, and stays in the same directory
// so the rename never crosses a volume.
async function writePointer(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  writeCounter += 1;
  const temporary = `${file}.${process.pid}.${writeCounter}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readHostPointer(key = hostKey()) {
  return key ? readPointer(hostPointerPath(key)) : null;
}

// Called by every process the host hands a session id to: the hooks, which are
// told on stdin, and the CLI, whose environment is fresh because it was spawned
// for this command. Last write wins — they are all reporting the same fact, and
// a hook runs at the end of every turn, so a wrong one cannot persist.
//
// Returns the id actually recorded, or null when there was nothing to record —
// no host key, or an id the host did not supply.
export async function writeHostPointer(rawId, { source = "unknown", key = hostKey() } = {}) {
  const id = normalizeHostSessionId(rawId);
  if (!id || !key) {
    return null;
  }
  try {
    await writePointer(hostPointerPath(key), {
      sessionId: id,
      source,
      pid: process.pid,
      updatedAt: new Date().toISOString()
    });
    return id;
  } catch {
    // Recording this is never worth failing the command that triggered it: the
    // caller keeps working against the environment, as it did before.
    return null;
  }
}

// The session id to use, given what this process was started with.
//
// The pointer wins when the two disagree, because by construction it is the
// newer of the two: the environment was frozen when this process started and the
// pointer was written by a process that started later.
//
// The one case where that reasoning fails is a leftover pointer from a host that
// used to have this pid. It cannot describe a change that happened after this
// process started, so a *disagreeing* pointer older than this process is ignored.
// A real session change is always newer than the bridge that is reading it.
export async function resolveHostSessionId(envSessionId, { since = 0, key = hostKey() } = {}) {
  const fallback = normalizeHostSessionId(envSessionId) ?? envSessionId ?? null;
  const pointer = await readHostPointer(key);
  if (!pointer || pointer.sessionId === envSessionId) {
    return fallback;
  }
  if (since > 0 && pointer.updatedAt < since) {
    return fallback;
  }
  return pointer.sessionId;
}

// What the bridge resolved, published so a slash command can check its success
// against the process that will actually serve it rather than against its own
// write.
//
// Written when the answer changes and not on a timer: the bridge re-resolves
// several times a second and a file that says the same thing is not worth
// rewriting. Age is not staleness here — a record from an hour ago is still what
// this bridge is serving. Whether it is *running* is a question about its pid,
// which the record carries.
//
// The cache is what this process last wrote, not what is on disk. Something that
// deleted the file from underneath it would not get it back until the session
// changes; nothing here does that, and defending against an outside `rm` would
// cost a stat on every message.
let lastPublished = { id: undefined };

export async function publishBridgeSession(id, { key = hostKey(), now = Date.now() } = {}) {
  if (!key) {
    return false;
  }
  if (lastPublished.id === id) {
    return false;
  }
  try {
    await writePointer(bridgePointerPath(key), {
      pid: process.pid,
      sessionId: id ?? null,
      updatedAt: new Date(now).toISOString()
    });
    // Only once it is actually on disk: a write that failed has published
    // nothing, and must not stop the next attempt.
    lastPublished = { id };
    return true;
  } catch {
    return false;
  }
}

// Only a record left by a bridge that is still running says anything about what
// this session is being served right now.
export async function readBridgeSession(key = hostKey(), { alive = isProcessAlive } = {}) {
  const record = key ? await readPointer(bridgePointerPath(key)) : null;
  if (!record || record.pid === null || !alive(record.pid)) {
    return null;
  }
  return record;
}

// Waits for the bridge to be serving `id`, and reports what it found rather than
// deciding what to do about it: the caller is a command whose success message
// depends on the answer.
//
// `state` is "matched" (the bridge is on this session), "unknown" (no bridge is
// publishing, so there is nothing to check against — an older bridge, or none
// running at all), or "drifted".
export async function awaitBridgeSession(
  id,
  { timeoutMs = 3000, intervalMs = 100, key = hostKey() } = {}
) {
  if (!id || !key) {
    return { state: "unknown" };
  }
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  for (;;) {
    seen = await readBridgeSession(key);
    if (seen?.sessionId === id) {
      return { state: "matched", seen };
    }
    // Nothing is publishing: a bridge from before this existed, or none running.
    // There is no answer coming, so waiting for one only delays the command.
    if (!seen || Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return seen ? { state: "drifted", seen } : { state: "unknown" };
}

// Pointers name a process, and processes end. Sweeping them keeps a machine that
// opens a lot of windows from accumulating a file per pid forever, and — more to
// the point — keeps a recycled pid from finding an ancient pointer waiting for
// it. Best effort: a failed sweep is not a failed command.
export async function pruneHostPointers({ alive = isProcessAlive } = {}) {
  let entries;
  try {
    entries = await readdir(hostsDirectory());
  } catch {
    return 0;
  }
  const mine = hostKey();
  let removed = 0;
  for (const entry of entries) {
    const key = entry.replace(/\.bridge\.json$|\.json$/, "");
    if (key === entry || key === mine) {
      continue;
    }
    const pid = /^pid-([1-9][0-9]{0,9})$/.exec(key);
    if (!pid || alive(Number(pid[1]))) {
      continue;
    }
    await rm(path.join(hostsDirectory(), entry), { force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

export function isProcessAlive(pid) {
  try {
    // Signal 0 checks for the process without touching it. EPERM means it exists
    // and belongs to someone else, which still counts as alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
