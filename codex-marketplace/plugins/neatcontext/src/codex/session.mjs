// Codex host adapter for the reusable session-aware runtime.
//
// Codex does not hand this plugin a session identity that all of its processes
// can see, so this adapter deliberately claims none.
//
// `CODEX_THREAD_ID` looks like the answer and is not. Codex exports it to the
// processes it starts through its shell tool — which is the CLI a skill runs,
// and nothing else. The MCP bridge is started with a scrubbed environment: the
// platform basics, plus whatever `.mcp.json` sets literally. No `CODEX_*`
// variable reaches it, and there is nowhere else for it to look. Codex's MCP
// client advertises no `roots` capability and answers `roots/list` with an
// empty list; a plugin server's `cwd` has to point inside the plugin, so it
// cannot even name the workspace it is serving; and hooks are spawned from a
// different parent process than the bridge, so a pointer file keyed on the
// host process never joins the two halves either.
//
// Scoping on a value only half the plugin can read is worse than not scoping at
// all. It splits the selection in silence: `use_context` writes the thread's
// file from the bridge, `$neatcontext:status` reads the machine's file from the
// CLI, and the user is told nothing is connected one line after being told a
// context was. The Copilot adapter refuses the same trade for the same reason.
//
// So one scope, shared by the bridge, the hook, and the CLI: one selection, one
// routing mode, one set of declines. Two Codex windows on a machine share them
// too, which is coarser than this plugin would like — but it is what the host
// currently exposes, and a shared answer that is true beats a private one that
// only one half of the plugin can see.
//
// NEATCONTEXT_SESSION_ID is the way back. A host that can inject one id into
// every one of its plugin processes — and any test that wants two sessions —
// gets per-session scoping again through it.

import { configureSessionId } from "../core/session.mjs";

// A session id becomes a path segment (`plugin-sessions/<id>.json`), so anything
// that could climb out of that directory, or name the directory itself, is not
// a session id.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function codexSessionId() {
  const explicit = process.env.NEATCONTEXT_SESSION_ID;
  if (typeof explicit !== "string") {
    return null;
  }
  const id = explicit.trim();
  return SAFE_SESSION_ID.test(id) ? id : null;
}

configureSessionId(codexSessionId);
