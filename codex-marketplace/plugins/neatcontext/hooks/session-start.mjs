// Re-inject the small routing menu at startup, resume, clear, and compaction.
// Profiles and knowledge are deliberately not injected here; get_context loads
// only the selected context after routing has chosen it.
//
// The thread id Codex delivers on stdin is deliberately not used to scope
// anything. It would scope this hook and the skill-run CLI to a thread the MCP
// bridge cannot name, and the menu printed here would then describe a selection
// the bridge is not serving. See src/codex/session.mjs for what Codex does and
// does not expose.

import { readSelection } from "../src/core/local-state.mjs";
import "../src/codex/session.mjs";
import { pruneHostPointers } from "../src/core/host-session.mjs";
import {
  menuEntries,
  readRouting,
  renderMenu,
  resolveMode
} from "../src/core/routing.mjs";
import { sessionId } from "../src/core/session.mjs";
import { listAllContexts } from "../src/core/selection.mjs";

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

// Read and discard: Codex writes the hook payload to stdin and this hook has
// nothing left to take from it, but a reader that never drains it leaves the
// host writing into a pipe nobody empties.
await readInput().catch(() => ({}));

// Earlier versions of this plugin left one pointer file per host process behind.
// Nothing writes them now; sweeping the ones whose process is gone is what
// clears them off machines that ran those versions.
await pruneHostPointers().catch(() => undefined);

const [{ contexts }, state, selection] = await Promise.all([
  listAllContexts(),
  readRouting(),
  readSelection().catch(() => null)
]);
const mode = resolveMode(state, sessionId());
const selected = selection?.available === false ? null : selection;
const menu = renderMenu(menuEntries(contexts, state), {
  connectedId: selected?.contextId ?? null,
  mode
});

const groundingGuidance = selected
  ? `The "${selected.contextName}" context is connected. For a request in its scope, call \`get_context\` only if its result is not already present since the latest context switch or compaction; otherwise reuse the existing result. Do not call \`get_context\` merely to check connection status.`
  : contexts.length > 0
    ? "No NeatContext context is connected. Do not call `get_context` to check connection status. Follow the routing menu, and load grounding only after `use_context` succeeds."
    : "No NeatContext contexts are currently available. Do not call `get_context`. Continue normal work without NeatContext grounding unless the user asks to create or import a context.";

const guidance = [
  "NeatContext is installed for this Codex session.",
  groundingGuidance,
  "Connect or switch contexts from here with `use_context` or the explicit `$neatcontext:use` skill. Disconnect the current context with `$neatcontext:disconnect`. There is no Desktop connection right now.",
  menu,
  "Use `$neatcontext:save` to preserve durable work from the visible conversation. Never parse Codex transcript files for that workflow."
]
  .filter(Boolean)
  .join("\n\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: guidance
    }
  })
);
