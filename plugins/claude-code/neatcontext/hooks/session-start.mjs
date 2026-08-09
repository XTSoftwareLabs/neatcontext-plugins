// SessionStart hook: tell the long-lived MCP bridge which session this host
// process is on now.
//
// This is the only moment anything in the plugin learns that `/clear` happened.
// Claude Code starts a new session inside the same process and does not restart
// the MCP server, so the bridge's `CLAUDE_CODE_SESSION_ID` still names the
// session that just ended. Left alone, it keeps serving that session's context —
// and `/neatcontext:use` keeps reporting success for a file the bridge will
// never read.
//
// The hook is spawned per event and is told the current session id on stdin, so
// it is the earliest and most reliable place to record it: written here, the
// correction lands before the session's first question can be asked.
//
// It also reports what `/clear` disconnected. A new session inherits no context
// by design — a context belongs to the conversation it was connected for — but
// until now the bridge made it look as though it carried over, so vanishing
// silently would read as the bug rather than the fix.

import { configureSessionId } from "../src/core/session.mjs";
import { readSelection } from "../src/core/local-state.mjs";
import {
  hostKey,
  pruneHostPointers,
  readHostPointer,
  writeHostPointer
} from "../src/core/host-session.mjs";

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

// What the session that just ended was grounded in, so it can be offered back
// rather than silently dropped. Read before the pointer is overwritten: the
// pointer is the only record of which session that was.
async function previousSelection(previousId, currentId) {
  if (!previousId || previousId === currentId) {
    return null;
  }
  configureSessionId(() => previousId);
  const selection = await readSelection().catch(() => null);
  return selection?.contextName ?? null;
}

async function main() {
  const input = await readInput();
  const id =
    typeof input.session_id === "string" && input.session_id.trim().length > 0
      ? input.session_id.trim()
      : null;
  if (!id || !hostKey()) {
    return;
  }

  const pointer = await readHostPointer().catch(() => null);
  const dropped =
    input.source === "clear" ? await previousSelection(pointer?.sessionId ?? null, id) : null;

  configureSessionId(() => id);
  await writeHostPointer(id, { source: "session-start" });
  // A pointer names a process, and processes end. Startup is the natural moment
  // to clear out the ones whose host is gone.
  await pruneHostPointers().catch(() => undefined);

  if (dropped) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            `The "${dropped}" NeatContext context was connected before this conversation was ` +
            "cleared. A new conversation starts with no context on purpose. If the user " +
            `continues that work, tell them to run \`/neatcontext:use ${dropped}\` — do not ` +
            "assume the context is still connected, and call get_context before grounding " +
            "anything in it."
        }
      })
    );
  }
}

// Silent either way. Recording which session this is must never be able to
// interrupt, delay, or fail the start of one.
main().catch(() => undefined);
