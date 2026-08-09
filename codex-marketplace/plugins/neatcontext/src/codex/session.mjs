// Codex host adapter for the reusable session-aware runtime.
//
// `CODEX_THREAD_ID` is right for any process Codex spawns per event — the
// SessionStart hook, the CLI a skill runs. It is right for the MCP bridge too,
// for exactly as long as the thread it was spawned in lasts: `/new` starts a
// new thread inside the same host process, and the bridge's environment still
// names the old one. Reading it there is how a bridge ends up serving one
// thread's context to another.
//
// So the id is *resolved* rather than read: short-lived processes keep the
// environment, and the bridge asks `refreshSessionId()` before it handles
// anything, which lets the pointer written by the SessionStart hook correct the
// stale copy. See core/host-session.mjs.

import { configureSessionId } from "../core/session.mjs";
import { publishBridgeSession, resolveHostSessionId } from "../core/host-session.mjs";

// When this process started. A pointer older than this cannot be describing a
// thread change that happened after it, and is therefore not about this host.
const STARTED_AT = Date.now();

function environmentThreadId() {
  return process.env.CODEX_THREAD_ID;
}

// Until something resolves it, the environment answers directly — which is what
// every process that is spawned per event wants, and what this file did before
// there was anything else to consult.
const UNRESOLVED = Symbol("unresolved");
let resolved = UNRESOLVED;

export function codexThreadId() {
  return resolved === UNRESOLVED ? environmentThreadId() : resolved;
}

// Re-resolves the thread this host process is on now.
//
// Synchronous everywhere else on purpose: `sessionId()` is called from inside
// path joins all over the runtime, and every one of them would have to become
// async to await this. The bridge serializes its messages, so refreshing once
// at the top of each is enough for all of them to agree.
export async function refreshSessionId() {
  resolved = await resolveHostSessionId(environmentThreadId(), { since: STARTED_AT });
  return resolved;
}

// Publishes what this process resolved, so `$neatcontext:use` can verify its own
// success against the bridge instead of against the file it just wrote.
export async function publishSessionId() {
  await publishBridgeSession(codexThreadId() ?? null);
}

configureSessionId(codexThreadId);
