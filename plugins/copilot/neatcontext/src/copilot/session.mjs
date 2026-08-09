// GitHub Copilot host adapter for the reusable session-aware runtime.
//
// Copilot CLI exposes the current session to both the command process and the
// MCP server as COPILOT_AGENT_SESSION_ID. Prefer it so both halves select the
// same context even when the host starts them in different working directories.
//
// The workspace digest remains the fallback for hosts that do not publish a
// session id. In that case all Copilot sessions opened in one workspace share
// the selection, as they did before.
//
// NEATCONTEXT_SESSION_ID overrides the digest — for tests, and for any host
// that can inject a real per-session id into every plugin process.
//
// CLAUDE_CODE_SESSION_ID is deliberately NOT consulted, even though a
// Claude-compat host might set it: a variable only some of this plugin's
// processes see is worse than none, because the CLI and the MCP server would
// scope to different sessions and the selection would silently split. (It
// also leaks into child shells when the user launches Copilot from inside a
// Claude Code session, which would hijack the scope the same way.)

import { createHash } from "node:crypto";
import path from "node:path";
import { configureSessionId } from "../core/session.mjs";

function explicitId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function workspaceSessionId(workspace = process.cwd()) {
  const resolved = path.resolve(workspace);
  // Windows paths compare case-insensitively; two spellings of one folder must
  // not become two sessions.
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `copilot-ws-${digest}`;
}

export function copilotSessionId() {
  return (
    explicitId(process.env.NEATCONTEXT_SESSION_ID) ??
    explicitId(process.env.COPILOT_AGENT_SESSION_ID) ??
    workspaceSessionId()
  );
}

configureSessionId(copilotSessionId);
