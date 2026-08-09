import { clearSelection, readSelection, writeSelection } from "./local-state.mjs";
import { listContexts } from "./context-store.mjs";

export async function listAllContexts() {
  const contexts = await listContexts();
  return { contexts };
}

export function resolveContext(contexts, query) {
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) {
    const context = contexts[Number(trimmed) - 1];
    return context ? { context } : { error: "out_of_range" };
  }
  const lower = trimmed.toLowerCase();
  const exact = contexts.filter((context) => context.name.toLowerCase() === lower);
  if (exact.length === 1) {
    return { context: exact[0] };
  }
  const partial = contexts.filter((context) => context.name.toLowerCase().includes(lower));
  if (partial.length === 1) {
    return { context: partial[0] };
  }
  return { error: partial.length > 1 || exact.length > 1 ? "ambiguous" : "not_found" };
}

export async function applySelection(target) {
  await writeSelection({ contextId: target.id, contextName: target.name });
  return { name: target.name };
}

export async function disconnectSelection() {
  await clearSelection();
}

// Saving is the one command that makes a context out of the conversation in
// front of it, so it is the one place a connection can be inferred instead of
// asked for. A session with nothing connected has no grounding to lose and has
// just written the context that describes it: connect it here, and spare the
// user the `use` they would have typed next.
//
// A session that already has one keeps it, whatever the save wrote to. Saving
// under another name is Save As — filing this work somewhere else — and moving
// the session onto that copy would re-ground a conversation the user is still
// having, without them asking for it.
export async function connectAfterSave(target) {
  const selection = await readSelection().catch(() => null);
  if (selection && selection.available !== false) {
    return {
      connected: false,
      contextId: selection.contextId,
      contextName: selection.contextName
    };
  }
  await writeSelection({ contextId: target.id, contextName: target.name });
  return { connected: true, contextId: target.id, contextName: target.name };
}

export { clearSelection };
