// GitHub Copilot host adapter for the reusable session-aware runtime.
//
// This file used to say that Copilot exposes no session identity to plugin
// processes, and derived one by hashing `process.cwd()` instead — on the premise
// that every plugin process is given the workspace as its working directory.
// That premise is false. On Copilot CLI the MCP bridge is spawned with the
// *plugin installation* directory as its working directory while the CLI a slash
// command runs is spawned with the user's workspace, so the two halves of the
// plugin hashed different paths, read and wrote different selection files, and
// neither could observe the disagreement: `/neatcontext:use` reported success
// for a file `get_context` would never read.
//
// Copilot does publish a session identity, to the bridge and to the CLI alike:
//
//   COPILOT_AGENT_SESSION_ID   the session, distinct per window
//   COPILOT_LOADER_PID         the host process, which the bridge also sees as
//                              its own parent
//
// So a session here is a session, as on every other host, rather than a
// workspace. The workspace digest remains as the fallback for a Copilot build
// that publishes no session id, which keeps that case working exactly as it did
// — and no worse.
//
// Like Claude Code and Codex, the id is *resolved* rather than read: the bridge
// is spawned once and outlives the session it was spawned in, so it asks
// `refreshSessionId()` before it handles anything, which lets the pointer
// written by the freshly spawned CLI correct a stale copy. See
// core/host-session.mjs.
//
// NEATCONTEXT_SESSION_ID overrides everything — for tests, and for any host that
// can inject a real per-session id into every plugin process.
//
// CLAUDE_CODE_SESSION_ID is deliberately NOT consulted, even though a
// Claude-compat host might set it: it leaks into child shells when the user
// launches Copilot from inside a Claude Code session, which would scope this
// plugin to the outer host's session.

import { createHash } from "node:crypto";
import path from "node:path";
import { configureSessionId } from "../core/session.mjs";
import {
  configureHostPid,
  normalizeHostKey,
  normalizeHostSessionId,
  publishBridgeSession,
  resolveHostSessionId
} from "../core/host-session.mjs";

// When this process started. A pointer older than this cannot be describing a
// session change that happened after it, and is therefore not about this host.
const STARTED_AT = Date.now();

// A host-supplied id becomes a path segment (`plugin-sessions/<id>.json`), so it
// is held to the same rule as one arriving from a pointer file. An unusable
// value falls through to the next source rather than being repaired: an id this
// plugin invented would not be the one the other half of it computes.
function explicitId(value) {
  return normalizeHostSessionId(value);
}

export function workspaceSessionId(workspace = process.cwd()) {
  const resolved = path.resolve(workspace);
  // Windows paths compare case-insensitively; two spellings of one folder must
  // not become two sessions.
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `copilot-ws-${digest}`;
}

// What this process was started with. Never null: the workspace digest always
// answers, because a null session id would send every workspace to the one
// unscoped selection file they would then share.
export function environmentSessionId() {
  return (
    explicitId(process.env.NEATCONTEXT_SESSION_ID) ??
    explicitId(process.env.COPILOT_AGENT_SESSION_ID) ??
    workspaceSessionId()
  );
}

// Set, but not to something that can be a path segment.
//
// Worth saying out loud rather than falling through in silence: this used to
// accept any non-empty string, so a value with a `/` or a `:` in it that worked
// before now scopes the session somewhere else entirely.
export function unusableSessionOverride() {
  const raw = process.env.NEATCONTEXT_SESSION_ID;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return explicitId(raw) ? null : raw.trim();
}

// Whether the bridge and this process can arrive at the same session at all.
//
// One of these has to hold, or the two halves are back to hashing their own
// working directories — which are not the same directory — with no channel
// between them. It is not a guess: each branch is a thing the host either
// publishes to both processes or does not.
export function sessionIdentityIsShared() {
  return Boolean(
    explicitId(process.env.NEATCONTEXT_SESSION_ID) ??
      explicitId(process.env.COPILOT_AGENT_SESSION_ID) ??
      // The same rule `hostKey()` applies, asked through the same function: a
      // key accepted here and rejected there would claim a channel that was
      // never opened, which is the one thing this must not do.
      normalizeHostKey(process.env.NEATCONTEXT_HOST_KEY) ??
      // A host pid both halves can see is enough on its own: it names the
      // pointer file they share, which is what carries the session across.
      (/^[1-9][0-9]{0,9}$/.test(String(process.env.COPILOT_LOADER_PID ?? "").trim())
        ? "pid"
        : null)
  );
}

// Until something resolves it, the environment answers directly — which is what
// every process that is spawned per command wants, and what this file did before
// there was anything else to consult.
const UNRESOLVED = Symbol("unresolved");
let resolved = UNRESOLVED;

export function copilotSessionId() {
  return resolved === UNRESOLVED ? environmentSessionId() : resolved;
}

// Re-resolves the session this host process is on now.
//
// Synchronous everywhere else on purpose: `sessionId()` is called from inside
// path joins all over the runtime, and every one of them would have to become
// async to await this. The bridge serializes its messages, so refreshing once at
// the top of each is enough for all of them to agree.
export async function refreshSessionId() {
  resolved = await resolveHostSessionId(environmentSessionId(), { since: STARTED_AT });
  return resolved;
}

// Publishes what this process resolved, so `/neatcontext:use` can verify its own
// success against the bridge instead of against the file it just wrote.
export async function publishSessionId() {
  await publishBridgeSession(copilotSessionId() ?? null);
}

// Copilot publishes the host's own pid to the processes it spawns, including the
// shell a slash command runs in — where `process.ppid` is that shell rather than
// the host. The bridge, spawned by the host directly, sees the same number as
// its parent, so both halves agree on which pointer file is theirs.
configureHostPid(() => process.env.COPILOT_LOADER_PID);
configureSessionId(copilotSessionId);
