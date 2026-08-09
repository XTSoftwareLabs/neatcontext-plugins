// Stop hook: record where Claude keeps this session's transcript, and nothing
// else.
//
// This hook used to evaluate whether the moment was worth proposing a save, and
// hand the model an instruction to ask. That behavior is gone — saving is
// user-initiated through `/neatcontext:save`. Deciding when to save on the
// user's behalf produced prompts they had not asked for, so nothing here
// watches, scores, or proposes anything.
//
// The one job left exists because Claude passes the transcript location to
// hooks and to no other plugin process. `/neatcontext:save` needs it to compile
// its ephemeral, privacy-filtered evidence view, so it is recorded here. The
// path only — no transcript content is read or stored by this hook.
//
// This process writes nothing to stdout, ever. A hook that prints is a hook the
// user sees, and there is no longer anything worth showing them.

import { configureSessionId } from "../src/core/session.mjs";
// Registers which environment variable names this host's process, so the pointer
// written below lands on the file the bridge reads. The session provider it
// installs is overridden explicitly further down.
import "../src/claude/session.mjs";
import { writeHostPointer } from "../src/core/host-session.mjs";
import { updateRouting } from "../src/core/routing.mjs";
import { normalizeSaveState, rememberTranscriptPath } from "../src/core/session-state.mjs";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const input = JSON.parse(raw);
  const id =
    typeof input.session_id === "string" && input.session_id.trim()
      ? input.session_id.trim()
      : null;
  if (!id) return;
  configureSessionId(() => id);

  // Re-assert which session this host process is on, every turn. SessionStart is
  // what makes the MCP bridge notice a `/clear`; this is what heals the record if
  // that hook did not run, or if something else wrote it wrongly in between.
  await writeHostPointer(id, { source: "stop" }).catch(() => undefined);

  const save = normalizeSaveState({});
  if (!rememberTranscriptPath(save, input.transcript_path)) return;

  await updateRouting((state) => {
    // Already recorded: skip the write rather than rewriting the routing file
    // on every turn of every session, which is what used to age other sessions
    // out of it.
    if (normalizeSaveState(state.sessions[id]?.save).transcriptPath === save.transcriptPath) {
      return;
    }
    state.sessions[id] = {
      ...state.sessions[id],
      save,
      updatedAt: new Date().toISOString()
    };
  });
}

// A truthful exit either way: this is bookkeeping, and a crash must look the
// same as a quiet success — recording a path is never worth failing a stop
// over. No process.exit(): it can truncate work still in flight.
main().catch(() => undefined);
