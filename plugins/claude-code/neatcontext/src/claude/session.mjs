// Claude Code host adapter for the reusable session-aware runtime.
//
// `CLAUDE_CODE_SESSION_ID` is right for any process Claude Code spawns per
// command — every slash command, every hook. It is right for the MCP bridge too,
// for exactly as long as the session it was spawned in lasts: `/clear` starts a
// new session inside the same host process, and the bridge's environment still
// names the old one. Reading it there is how a bridge ends up serving one
// session's context to another.
//
// So the id is *resolved* rather than read: short-lived processes keep the
// environment, and the bridge asks `refreshSessionId()` before it handles
// anything, which lets the pointer written by this session's hooks and slash
// commands correct the stale copy. See core/host-session.mjs.

import { configureSessionId } from "../core/session.mjs";
import { publishBridgeSession, resolveHostSessionId } from "../core/host-session.mjs";

// When this process started. A pointer older than this cannot be describing a
// session change that happened after it, and is therefore not about this host.
const STARTED_AT = Date.now();

function environmentSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID;
}

// Until something resolves it, the environment answers directly — which is what
// every process that is spawned per command wants, and what this file did before
// there was anything else to consult.
const UNRESOLVED = Symbol("unresolved");
let resolved = UNRESOLVED;

export function claudeSessionId() {
  return resolved === UNRESOLVED ? environmentSessionId() : resolved;
}

// Re-resolves the session this host process is on now.
//
// Synchronous everywhere else on purpose: `sessionId()` is called from inside
// path joins and header builders all over the runtime, and every one of them
// would have to become async to await this. The bridge serializes its messages,
// so refreshing once at the top of each is enough for all of them to agree.
export async function refreshSessionId() {
  resolved = await resolveHostSessionId(environmentSessionId(), { since: STARTED_AT });
  return resolved;
}

// Publishes what this process resolved, so `/neatcontext:use` can verify its own
// success against the bridge instead of against the file it just wrote.
export async function publishSessionId() {
  await publishBridgeSession(claudeSessionId() ?? null);
}

configureSessionId(claudeSessionId);
