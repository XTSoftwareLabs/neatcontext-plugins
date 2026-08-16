// Everything the pi extension does, as plain async functions that return text.
//
// This file is the pi equivalent of the other hosts' `mcp-bridge.mjs` plus
// `neatcontext-cli.mjs`, collapsed into one module — because in pi they collapse
// for real. Claude Code, Codex and Kimi each spawn the plugin as an MCP server
// beside the agent; pi has no MCP at all, and loads extensions *inside* the
// agent process instead. So there is no JSON-RPC framing to speak, no stdio loop
// to pump, no handshake to replay, and no `tools/list_changed` poll to keep a
// tool list fresh: the extension registers its tools directly and recomputes its
// grounding notes on every turn.
//
// Contexts are answered locally from disk with no network dependency.
//
// Nothing here imports pi. Keeping the logic host-free is what lets the tests
// drive it without a running agent, and it is the same reason `src/core` is
// shared verbatim with the other hosts.

import { readFile } from "node:fs/promises";
import path from "node:path";
import "./session.mjs";
import {
  createCapturedContext,
  createContext as createStoredContext,
  deleteContext as deleteStoredContext,
  exportContext as exportStoredContext,
  fingerprintContext,
  importCapturedContext,
  CONTEXT_MISSING_MESSAGE,
  ContextError,
  listKnowledgeFiles,
  previewCapturedContextUpdate,
  readContext,
  readProfileText,
  renderContext,
  updateCapturedContext
} from "../core/context-store.mjs";
import {
  addExtensionToContext,
  removeExtensionFromContext,
  renderExtensionsStatus,
  testExtension
} from "../core/extension-commands.mjs";
import {
  createExtensionHost,
  renderExtensionStatus,
  renderExtensionTools
} from "../core/extension-runtime.mjs";
import { clearSelection, readSelection } from "../core/local-state.mjs";
import {
  addAlias,
  isCardStale,
  menuEntries,
  MODES,
  noteDecision,
  noteDeclined,
  putCard,
  readRouting,
  renderMenu,
  renderShortlist,
  resolveMode,
  sessionId,
  setMode,
  switchPolicy
} from "../core/routing.mjs";
import { assess, createRoutingIndex } from "../core/routing-candidates.mjs";
import {
  applySelection,
  connectAfterSave,
  disconnectSelection,
  listAllContexts,
  resolveContext
} from "../core/selection.mjs";

export const PLUGIN_VERSION = "0.1.1";

// What to say when a session has nothing to ground in. It is deliberately about
// what to do in the current session.
//
// This one is for when routing cannot help: manual mode, or a store with
// nothing in it yet. A command the user types is then genuinely the only way
// forward.
export const NOTHING_CONNECTED =
  "No NeatContext Context is connected to this session. Connect one with " +
  "`/neatcontext-use`, save this conversation with `/neatcontext-save`, or create one " +
  "with `/neatcontext-create`. Until then, do not answer from general knowledge.";

// What to say instead when routing is on and there are contexts to route to.
//
// Leading with `/neatcontext-use` in that situation is what made routing look
// broken. This text is the first and most imperative thing the model reads, and
// it answered "what now?" with a command for the user to type before the menu
// below ever got a turn — so a question that plainly belonged to a saved
// context came back as an offer to go and connect one by hand. The menu is
// still what carries the mode-specific rules; these two only have to stop
// contradicting it.
export const NOTHING_CONNECTED_ROUTABLE =
  "No NeatContext Context is connected to this session. There are contexts on this machine, " +
  "listed below with what each one is for. Connect the one this request belongs to with " +
  "`use_context`, then call `get_context` again and answer from what it returns — do not ask " +
  "the user to run a command to connect a context you can already name. If none of them covers " +
  "the request, say so and offer `/neatcontext-save` to make one out of this conversation. " +
  "Until then, do not answer from general knowledge.";

export const NOTHING_CONNECTED_ASK =
  "No NeatContext Context is connected to this session. There are contexts on this machine, " +
  "listed below with what each one is for. Routing is in ask mode, so name the one this request " +
  "belongs to and ask whether to connect it rather than connecting first. If none of them " +
  "covers the request, say so and offer `/neatcontext-save` to make one out of this " +
  "conversation. Until then, do not answer from general knowledge.";

// The mode decides whether a menu is about to follow this text, and therefore
// whether pointing at a slash command is the honest answer or the one that
// breaks routing.
export async function nothingConnectedText() {
  const { contexts } = await listAllContexts().catch(() => ({ contexts: [] }));
  if (contexts.length === 0) {
    return NOTHING_CONNECTED;
  }
  const mode = resolveMode(await readRouting().catch(() => ({ sessions: {} })), sessionId());
  if (mode === "manual") {
    return NOTHING_CONNECTED;
  }
  return mode === "ask" ? NOTHING_CONNECTED_ASK : NOTHING_CONNECTED_ROUTABLE;
}

// How connecting works in pi.
const CONNECTION_RULE = `## Connecting a context, in pi

Contexts are connected from this session and nowhere else: the \`use_context\` tool, or \`/neatcontext-use <name>\` run by the user. \`/neatcontext-disconnect\` disconnects the current one from this session. \`/neatcontext-save\` saves the current conversation and \`/neatcontext-create\` makes one from a knowledge folder.

There is no Desktop connection right now. Contexts are stored by this plugin. When the connected context is the wrong one, or none is connected, name the one you need and connect it here with \`use_context\` — or offer to, when the routing rules above say to ask first.`;

const CONTEXT_INSTRUCTIONS = `This session can be grounded in a NeatContext Context: one domain profile and local knowledge stored on this machine.

Call the get_context tool before answering anything that depends on the user's own domain, documents, tools, or team conventions — it returns the profile file to read and the knowledge folder to search. Read the profile in full: it states what the context is for, what to do, what to avoid, and how to behave, and it is your primary behavioral guide for this session.

A context is whatever its profile says it is. Do not assume a subject area for it, and do not impose a response format it does not ask for.

Cite the exact file path of anything you rely on. When the profile and the knowledge folder do not cover the question, say so instead of answering from general knowledge.`;

// Unlike the MCP hosts, pi re-reads this every turn, so it can state the current
// situation as a fact instead of hedging about a handshake it cannot revise.
const NO_CONTEXT_INSTRUCTIONS = `No NeatContext Context is connected to this session right now. A Context can be connected at any time, from this session or another window, and this note is rebuilt on every turn — so treat it as current rather than as something fixed at startup.

When the user asks anything that depends on their own domain, documents, tools, or team conventions, call the get_context tool and let its answer decide:

- If it returns a Context, ground your answer in it and cite what you used.
- If it reports that nothing is connected, it also lists the contexts that exist and says what to do about them — which may be to connect one yourself with the use_context tool, to ask the user first, or to tell them to run a command. Do what that answer says, rather than substituting a slash command of your own for the route it offers.`;

// --- which source serves this session ----------------------------------------

// A selection whose context was deleted out-of-band resolves to `missing` so
// get_context can report what happened.
export async function activeContext() {
  const selection = await readSelection().catch(() => null);
  if (!selection || selection.available === false) {
    return null;
  }
  const record = await readContext(selection.contextId).catch(() => null);
  return record ? { record } : { missing: true, name: selection.contextName };
}

// --- the notes the plugin adds to every turn ---------------------------------

// What the model needs to route: the contexts worth considering, one line each
// on what they are for, and the rules for acting on that. Rebuilt on demand
// rather than cached, so `/neatcontext-mode` and a context created mid-session
// both take effect on the next turn instead of on the next restart.
//
// With a request to match against, that is the few contexts that matched it;
// without one it is everything, alphabetically, as it has always been.
const SHORTLIST_LIMIT = 5;
const SHORTLIST_MIN_CONTEXTS = 8;

// One index for this process. pi runs the extension in-process, so this lives
// as long as the session does and is rebuilt when the contexts change rather
// than per question.
const rankContexts = createRoutingIndex({
  listFiles: async (record) =>
    (await listKnowledgeFiles(record.knowledgeFolder, { limit: 60 })).files
});

async function routingMenu(query) {
  const [{ contexts }, state] = await Promise.all([listAllContexts(), readRouting()]);
  const selection = await readSelection().catch(() => null);
  const options = {
    connectedId: selection?.contextId ?? null,
    mode: resolveMode(state, sessionId())
  };
  const entries = menuEntries(contexts, state);
  const shortlist = await shortlistFor(contexts, state, entries, query, options.connectedId);
  return shortlist
    ? renderShortlist(shortlist, { ...options, decision: assess(shortlist) })
    : renderMenu(entries, options);
}

// A shortlist needs three things: a request to match against, enough contexts
// that narrowing gains anything, and at least one that actually matched. Any of
// them missing and the full menu goes out instead — a session is never left
// with less to work with than it has today.
async function shortlistFor(contexts, state, entries, query, connectedId) {
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    entries.length < SHORTLIST_MIN_CONTEXTS
  ) {
    return null;
  }
  const ranked = await rankContexts(contexts, state, query, {
    limit: SHORTLIST_LIMIT,
    connectedId
  });
  if (ranked.length === 0) {
    return null;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // The score travels with the entry because how far ahead the leader is
  // decides whether the shortlist names a winner or asks a question.
  return ranked.map((result) => ({
    ...byId.get(result.id),
    matched: result.matched,
    score: result.score
  }));
}

// The routing menu when there is one, and how connecting works here. The
// connection rule goes last, so it is the closest thing to the answer the
// session is about to write — and it is the one part that is never omitted.
//
// Called with no query from the per-turn system prompt, which has no request to
// match against, and with one from get_context.
export async function pluginNotes(query) {
  const menu = await routingMenu(query).catch(() => null);
  return menu ? `${menu}\n\n${CONNECTION_RULE}` : CONNECTION_RULE;
}

// Appended to pi's system prompt before every turn. The MCP hosts can only say
// this once, during a handshake they cannot revise, and have to write it to
// survive being wrong about the current state. Here it is rebuilt each turn, so
// it can simply describe what is true now.
export async function sessionInstructions() {
  const context = await activeContext().catch(() => null);
  const head = context ? CONTEXT_INSTRUCTIONS : NO_CONTEXT_INSTRUCTIONS;
  return `# NeatContext\n\n${head}\n\n${await pluginNotes()}`;
}

// --- get_context --------------------------------------------------------------

// --- Extensions ---------------------------------------------------------------
//
// pi fixes its tool list when the extension loads, so an extension's tools
// cannot be registered per context the way the MCP hosts register them. They are
// reached through the one `use_extension` tool instead, and get_context — which
// pi rebuilds every turn — is where their names, arguments and current status
// are written down.

const extensionHost = createExtensionHost();

async function resolveExtensions(context) {
  const record = context && !context.missing ? context.record : null;
  return extensionHost.resolve(record).catch(() => ({ statuses: [], tools: [] }));
}

// Everything the model needs to use an extension, or to explain why it cannot.
function renderExtensions({ statuses, tools }) {
  const status = renderExtensionStatus(statuses);
  if (!status) return "";
  const calling = renderExtensionTools(tools);
  return calling ? `${status}\n\n${calling}` : status;
}

export async function useExtension(args = {}) {
  const name = typeof args.tool === "string" ? args.tool.trim() : "";
  const context = await activeContext();
  if (!context || context.missing) {
    return (
      "No NeatContext Context is connected to this session, so there are no extension tools " +
      "to call. Connect one first."
    );
  }

  const { statuses, tools } = await resolveExtensions(context);
  if (tools.length === 0) {
    const declared = statuses.length > 0;
    return declared
      ? `The "${context.record.name}" context declares extensions, but none of them are ` +
          "available right now. Tell the user what was missing, and answer from the profile " +
          `and knowledge folder instead.\n\n${renderExtensionStatus(statuses)}`
      : `The "${context.record.name}" context declares no extensions, so there is nothing ` +
          "to call here.";
  }

  const result = await extensionHost.call(name, args.arguments);
  if (!result) {
    return (
      `"${name || "(no tool named)"}" is not something this context can call. It can call: ` +
      `${tools.map((tool) => tool.name).join(", ")}.`
    );
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const body = content
    .map((entry) => (typeof entry?.text === "string" ? entry.text : JSON.stringify(entry)))
    .join("\n");
  return body.length > 0 ? body : "The extension returned nothing.";
}

// The `/neatcontext-extensions` command: what the connected context asks for,
// and whether this machine answers.
export async function commandExtensions(input = "") {
  const [action = "", ...rest] = String(input).trim().split(/\s+/).filter(Boolean);
  const id = rest.join(" ").trim();
  const state = await loadState();
  const record = state.connected?.record ?? null;

  if (action.length === 0 || action === "status") {
    return renderExtensionsStatus(record);
  }
  if (!record) {
    return "No context is connected to this session, so there is nothing to change.";
  }
  if (action === "test") {
    return id.length > 0 ? testExtension(record, id) : "Use: /neatcontext-extensions test <id>";
  }
  if (action === "remove") {
    return id.length > 0
      ? (await removeExtensionFromContext(record, id)).text
      : "Use: /neatcontext-extensions remove <id>";
  }
  return (
    `Unknown extensions action "${action}". Use: status | remove | test. ` +
    "Add one with the neatcontext_declare_extension tool."
  );
}

// Declaring is a tool rather than a command because the capability line is
// written by the model from what the user just described, the same way a
// routing description is.
export async function declareExtension({ id, capability, tools, important } = {}) {
  const state = await loadState();
  const record = state.connected?.record ?? null;
  if (!record) {
    return "No context is connected to this session, so there is nothing to declare against.";
  }
  if (typeof id !== "string" || typeof capability !== "string" || capability.trim().length === 0) {
    return "Pass the extension `id` and a `capability` line saying what it lets this context do.";
  }
  const added = await addExtensionToContext(record, id, {
    capability,
    tools: Array.isArray(tools) ? tools.join(",") : undefined,
    important: important === true
  });
  return added.text;
}

export async function getContext(query) {
  const context = await activeContext();
  if (context) {
    const body = context.missing
      ? CONTEXT_MISSING_MESSAGE
      : await renderContext(context.record);
    const extensions = renderExtensions(await resolveExtensions(context));
    const parts = extensions ? [body, extensions] : [body];
    return `${parts.join("\n\n")}\n\n${await pluginNotes(query)}`;
  }
  await resolveExtensions(null);
  return `${await nothingConnectedText()}\n\n${await pluginNotes(query)}`;
}

// --- routing tools ------------------------------------------------------------

async function previewContextText(target) {
  const state = await readRouting();
  const card = state.cards[target.id];
  const useWhen = card?.useWhen || target.routingDescription;
  const lines = [`# ${target.name}`, ""];
  lines.push(useWhen || "No routing description has been derived for it yet.");
  if (card?.aliases?.length > 0) {
    lines.push("", `Also called: ${card.aliases.join(", ")}`);
  }
  const { files } = await listKnowledgeFiles(target.knowledgeFolder, { limit: 40 });
  lines.push("", "Knowledge folder holds:", "");
  lines.push(files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- (nothing yet)");
  // Deliberately no profile prose. A profile is mostly behavioral, and text
  // telling the model how to answer would be acting on this context while the
  // session is still grounded in another one.
  lines.push("", "Switch to it with use_context, or stay where you are.");
  return lines.join("\n");
}

export async function previewContext({ context } = {}) {
  const query = typeof context === "string" ? context : "";
  const { contexts } = await listAllContexts();
  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    return noSingleMatch(query, contexts);
  }
  return previewContextText(resolution.context);
}

function noSingleMatch(query, contexts) {
  return (
    `No single context matched "${query}". The contexts are: ` +
    `${contexts.map((context) => context.name).join(", ") || "(none)"}.`
  );
}

function refusal(policy, target) {
  if (policy.reason === "already-connected") {
    return `"${target.name}" is already the connected context. Nothing to switch.`;
  }
  if (policy.reason === "manual-mode") {
    return (
      "Context routing is off (manual mode). Do not switch. If the answer needs a different " +
      `context, tell the user to run \`/neatcontext-use ${target.name}\`.`
    );
  }
  if (policy.reason === "declined-this-session") {
    return (
      `The user already declined switching to "${target.name}" in this session. Do not ask ` +
      "again — answer with the context that is connected, or say what it cannot cover."
    );
  }
  return (
    "Context routing is in ask mode, so nothing has changed yet. Ask the user whether to " +
    `switch to "${target.name}", say briefly why it looks like the right one, and call this ` +
    "tool again with `requested: true` only if they agree."
  );
}

// Mode is enforced here rather than by hiding the tool. The MCP hosts drop
// `use_context` from the tool list in manual mode and push a
// `tools/list_changed` when the mode moves; pi fixes its tool list for the
// session, so the tool stays registered and manual mode is a refusal instead of
// an absence. The user-visible contract is the same: in manual mode nothing
// switches except `/neatcontext-use`.
export async function useContext(args = {}) {
  const query = typeof args.context === "string" ? args.context : "";
  const { contexts } = await listAllContexts();
  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    return noSingleMatch(query, contexts);
  }
  const target = resolution.context;

  if (args.declined === true) {
    await noteDeclined(target.id);
    return (
      `Noted — "${target.name}" will not be suggested again this session. Answer with the ` +
      "context that is already connected."
    );
  }

  const selection = await readSelection().catch(() => null);
  const state = await readRouting();
  const policy = switchPolicy(state, {
    id: sessionId(),
    targetId: target.id,
    connectedId: selection?.contextId ?? null,
    requested: args.requested === true
  });
  if (!policy.allowed) {
    return refusal(policy, target);
  }

  const result = await applySelection(target);
  // The alias is the only routing signal the user authors, and it arrives here
  // because a wrong route is the moment they say what it should have been.
  const alias = typeof args.alias === "string" ? await addAlias(target.id, args.alias) : null;
  await noteDecision({
    sessionId: sessionId(),
    from: selection?.contextName ?? null,
    to: target.name,
    mode: policy.mode,
    reason: typeof args.reason === "string" ? args.reason : null,
    requested: args.requested === true
  });

  return (
    `Switched this session to "${result.name}".` +
    (alias ? ` "${alias}" will route here from now on.` : "") +
    " Call get_context now and answer from what it returns. Tell the user in one line that " +
    "you switched, and to what."
  );
}

// --- what the commands need to know about the world ---------------------------

// The local contexts and the selection recorded for this session.
export async function loadState() {
  const selection = await readSelection();
  const { contexts } = await listAllContexts();

  let connected = null;
  if (selection && selection.available !== false) {
    const record = contexts.find((context) => context.id === selection.contextId) ?? null;
    const routing = await readRouting();
    connected = {
      id: selection.contextId,
      name: record?.name ?? selection.contextName,
      record,
      stale: record
        ? isCardStale(routing.cards[selection.contextId], await readProfileText(record))
        : false
    };
  }

  return { contexts, selection, connected };
}

// --- commands -----------------------------------------------------------------

function formatSection(title, contexts, offset, connectedId, emptyNote) {
  if (contexts.length === 0) {
    return `${title}\n  ${emptyNote}`;
  }
  const width = Math.max(...contexts.map((context) => context.name.length), 0);
  const rows = contexts.map((context, index) => {
    const marker = context.id === connectedId ? "  (connected)" : "";
    return `  ${offset + index + 1}. ${context.name.padEnd(width)}${marker}`.trimEnd();
  });
  return [title, ...rows].join("\n");
}

export function formatList(state) {
  return formatSection(
    "Contexts:",
    state.contexts,
    0,
    state.connected?.id ?? null,
    "(none — save this conversation with `/neatcontext-save`, or create one with `/neatcontext-create`)"
  );
}

export async function commandStatus() {
  const state = await loadState();
  const { connected, selection } = state;
  const routing = await readRouting();
  const mode = resolveMode(routing, sessionId());
  const lines = [];

  // Reported alongside the connection because the two together are the whole
  // answer to "what is this session going to do": what it is grounded in, and
  // whether it may re-ground itself.
  const reportMode = () => {
    lines.push(`Context routing: ${mode} (change with \`/neatcontext-mode\`)`);
    if (connected?.stale === true) {
      lines.push(
        "  This context's routing description was derived from an older version of its " +
          "profile. Ask me to refresh it."
      );
    }
  };

  if (connected) {
    if (!connected.record) {
      lines.push(
        `The context "${connected.name}" is connected but is no longer on disk. ` +
          "Use `/neatcontext-list` to pick another, or `/neatcontext-create` to make a new one."
      );
      return lines.join("\n");
    }
    lines.push(`Connected context: ${connected.name}`);
    lines.push(`  Domain profile:   ${connected.record.profilePath}`);
    const folder = connected.record.knowledgeFolder;
    const { files } = await listKnowledgeFiles(folder);
    lines.push(`  Knowledge folder: ${folder}${files.length > 0 ? ` (${files.length} files)` : ""}`);
    if (files.length === 0) {
      lines.push(
        "  The knowledge folder is empty or missing — put TSGs, runbooks, or docs in it, " +
          "or check the path is still valid."
      );
    }
    if (!connected.record.knowledgeManaged && connected.record.conversationKnowledgeFolder) {
      const generated = await listKnowledgeFiles(connected.record.conversationKnowledgeFolder);
      if (generated.files.length > 0) {
        lines.push(
          `  Conversation knowledge: ${connected.record.conversationKnowledgeFolder} ` +
            `(${generated.files.length} files)`
        );
      }
    }
    reportMode();
    return lines.join("\n");
  }
  if (selection?.available === false) {
    lines.push(
      `The previously selected context "${selection.contextName}" is not available to this ` +
        "plugin. Its stale selection has been cleared; use `/neatcontext-use` to pick a local Context."
    );
    reportMode();
    return lines.join("\n");
  }
  lines.push("No context is connected yet. Use `/neatcontext-use` to pick one.");
  reportMode();
  return lines.join("\n");
}

export async function commandList() {
  const state = await loadState();
  return formatList(state);
}

// A context with no routing description can only be routed to by name.
async function nudgeForDescription(target) {
  const routing = await readRouting();
  if ((routing.cards[target.id]?.useWhen || target.routingDescription || "").length > 0) {
    return null;
  }
  return (
    "\n\nThis context has no routing description yet, so it can only be routed to by name. " +
    "Call `get_context`, then record one line of scope with the `describe_context` tool."
  );
}

export async function commandUse(query = "") {
  const state = await loadState();
  const { contexts } = state;
  if (contexts.length === 0) {
    return `No contexts to connect.\n\n${formatList(state)}`;
  }
  if (query.trim().length === 0) {
    return `Which context should I connect?\n\n${formatList(state)}`;
  }

  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    return `No single context matched "${query}".\n\n${formatList(state)}`;
  }

  const target = resolution.context;
  const result = await applySelection(target);
  const nudge = (await nudgeForDescription(target)) ?? "";
  return `Connected the "${result.name}" context. Your next messages in this session ` +
    `will be grounded in its domain profile and knowledge folder.${nudge}`;
}

export async function commandDisconnect() {
  const state = await loadState();
  const connected = state.connected;
  const remembered = state.selection;
  if (!connected && !remembered) {
    return "No context is connected to this session.";
  }
  await disconnectSelection();
  return `Disconnected the "${connected?.name ?? remembered.contextName}" context from this session.`;
}

export async function commandMode(query = "", { global: isGlobal = false } = {}) {
  const routing = await readRouting();
  const id = sessionId();
  const wanted = query.trim().toLowerCase();

  if (wanted.length === 0) {
    const active = resolveMode(routing, id);
    const scope = MODES.includes(routing.sessions[id]?.mode) ? "this session" : "the default";
    return [
      `Context routing is ${active} (${scope}).`,
      "",
      "  auto    switch context on a clear match, and say so; ask when it is a close call (default)",
      "  ask     always ask before switching",
      "  manual  never route — /neatcontext-use only",
      "",
      `Change it with \`/neatcontext-mode <${MODES.join("|")}>\`.`
    ].join("\n");
  }

  if (!MODES.includes(wanted)) {
    return `"${query}" is not a mode. Use one of: ${MODES.join(", ")}.`;
  }
  const result = await setMode(wanted, { global: isGlobal, id });
  const head =
    result.scope === "global"
      ? `Context routing is now ${wanted} everywhere (the default for new sessions).`
      : `Context routing is now ${wanted} for this session.`;
  return wanted === "auto"
    ? `${head}\nIn auto mode this session switches context on its own, and tells you when it ` +
        "does. Other pi sessions keep theirs."
    : head;
}

export async function createContext({ name, knowledgeFolder, profile, useWhen } = {}) {
  try {
    const created = await createStoredContext({
      name: typeof name === "string" ? name : "",
      knowledgeFolder: typeof knowledgeFolder === "string" ? knowledgeFolder : "",
      profile: typeof profile === "string" ? profile : ""
    });
    const { record, profileText, knowledgeFileCount } = created;
    // The routing line is derived from the profile by the model that ran this
    // command, and stored against the profile it was derived from: edit the
    // profile later and the hash stops matching, which is how a session finds out
    // the line now describes something the context no longer is.
    //
    // `profileText`, not `profile` — the stored profile is normalized, and
    // hashing the input would make every context stale from creation.
    const line = typeof useWhen === "string" ? useWhen : "";
    await putCard(record.id, { useWhen: line, source: profileText });

    const lines = [`Created the "${record.name}" context.`];
    lines.push(`  Domain profile:   ${record.profilePath}`);
    if (line.trim().length > 0) {
      lines.push(`  Routes here for:  ${line.trim()}`);
    }
    lines.push(
      `  Knowledge folder: ${record.knowledgeFolder}` +
        (knowledgeFileCount > 0 ? ` (${knowledgeFileCount} files)` : " (empty for now)")
    );
    lines.push(`  Connect it with:  /neatcontext-use ${record.name}`);
    if (knowledgeFileCount === 0) {
      lines.push(
        "The folder has no files yet — put the TSGs, runbooks, or docs in it before asking questions."
      );
    }
    return lines.join("\n");
  } catch (error) {
    if (error instanceof ContextError) {
      return error.message;
    }
    throw error;
  }
}

// Stores a routing description for a context that already exists. The line
// itself is written by the session's model — this only records it, against the
// text it was derived from so drift can be spotted later.
export async function describeContext({ context, useWhen, alias } = {}) {
  const { contexts } = await listAllContexts();
  const resolution = resolveContext(contexts, typeof context === "string" ? context : "");
  if (resolution.error) {
    return noSingleMatch(context, contexts);
  }
  const target = resolution.context;
  const line = typeof useWhen === "string" ? useWhen : "";
  const parts = [];
  if (line.trim().length > 0) {
    const source = (await readProfileText(target)) ?? undefined;
    const card = await putCard(target.id, { useWhen: line, source });
    parts.push(`"${target.name}" now routes for: ${card.useWhen}`);
  }
  if (typeof alias === "string") {
    const recorded = await addAlias(target.id, alias);
    if (recorded) {
      parts.push(`"${recorded}" now routes to "${target.name}".`);
    }
  }
  return parts.length > 0
    ? parts.join("\n")
    : "Pass a routing description as `useWhen`, or words to remember as `alias`.";
}

export async function importContext({ from, name } = {}) {
  const source = typeof from === "string" ? from : "";
  if (source.trim().length === 0) {
    return "Pass the shared bundle folder to import from.";
  }
  try {
    const result = await importCapturedContext({
      bundleFolder: source,
      name: typeof name === "string" ? name : ""
    });
    await putCard(result.record.id, {
      useWhen: result.routingDescription,
      source: result.profileText
    }).catch(() => undefined);
    return [
      `Imported the "${result.record.name}" conversation context.`,
      `  Domain profile:   ${result.record.profilePath}`,
      `  Knowledge folder: ${result.record.knowledgeFolder} (${result.knowledgeFileCount} files)`,
      `  Local bundle:     ${result.record.directory}`,
      `  Connect it with:  /neatcontext-use ${result.record.name}`,
      `The shared source folder (${source}) was left untouched.`
    ].join("\n");
  } catch (error) {
    if (error instanceof ContextError) {
      return error.message;
    }
    throw error;
  }
}

export async function exportContext({ context, destination, force = false } = {}) {
  const targetFolder = typeof destination === "string" ? destination : "";
  if (targetFolder.trim().length === 0) {
    return "Pass the destination folder with --to <folder>.";
  }

  const state = await loadState();
  let target = null;
  const query = typeof context === "string" ? context.trim() : "";
  if (query.length === 0) {
    if (!state.connected?.record) {
      return `Which context should I export?\n\n${formatList(state)}`;
    }
    target = state.connected.record;
  } else {
    const resolution = resolveContext(state.contexts, query);
    if (resolution.error) {
      return `No single context matched "${query}".\n\n${formatList(state)}`;
    }
    target = resolution.context;
  }

  const routing = await readRouting();
  try {
    const result = await exportStoredContext({
      record: target,
      destination: targetFolder,
      force,
      routingDescription: routing.cards[target.id]?.useWhen
    });
    return [
      result.replaced
        ? `Exported the "${result.record.name}" context, replacing what was there.`
        : `Exported the "${result.record.name}" context.`,
      `  Bundle folder:   ${result.destination}`,
      `  Knowledge files: ${result.knowledgeFileCount}`,
      `  Import it with:  /neatcontext-import ${result.destination}`,
      "This context was not changed — the export is a copy."
    ].join("\n");
  } catch (error) {
    if (error instanceof ContextError) {
      return error.message;
    }
    throw error;
  }
}

// Returns what deleting would do, so a caller with a confirmation dialog can
// show it before asking. `confirm` is what actually deletes.
export async function deleteContext(query = "", { confirm = false } = {}) {
  const state = await loadState();
  if (query.trim().length === 0) {
    return { done: false, text: `Which context should I delete?\n\n${formatList(state)}` };
  }

  const resolution = resolveContext(state.contexts, query);
  if (resolution.error) {
    return {
      done: false,
      text: `No single context matched "${query}".\n\n${formatList(state)}`
    };
  }

  const target = resolution.context;
  if (!confirm) {
    return {
      done: false,
      target,
      text: [
        `This will delete the "${target.name}" context:`,
        `  ${target.directory}`,
        target.knowledgeManaged
          ? `Its generated knowledge folder (${target.knowledgeFolder}) is inside the bundle and will be deleted.`
          : `Its knowledge folder (${target.knowledgeFolder}) will NOT be touched.`
      ].join("\n")
    };
  }

  const deleted = await deleteStoredContext(target.id);
  if (!deleted) {
    return { done: true, text: `The "${target.name}" context was already gone.` };
  }
  const lines = [
    `Deleted the "${deleted.name}" context.`,
    deleted.knowledgeManaged
      ? `Its generated knowledge folder (${deleted.knowledgeFolder}) was deleted with it.`
      : `Its knowledge folder (${deleted.knowledgeFolder}) was left untouched.`
  ];
  if (state.connected?.id === deleted.id) {
    await clearSelection();
    lines.push("It was the connected context, so this session is no longer grounded in one.");
  }
  return { done: true, text: lines.join("\n") };
}

// --- save ---------------------------------------------------------------------

function saveNameKey(value) {
  return value.trim().toLowerCase();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function similarSaveTargets(contexts, query) {
  const wanted = saveNameKey(query).replace(/[^a-z0-9]+/g, "");
  if (wanted.length < 3) {
    return [];
  }
  return contexts.filter((context) => {
    const candidate = saveNameKey(context.name).replace(/[^a-z0-9]+/g, "");
    if (candidate.includes(wanted) || wanted.includes(candidate)) {
      return true;
    }
    return (
      editDistance(wanted, candidate) <=
      Math.max(2, Math.floor(Math.max(wanted.length, candidate.length) * 0.2))
    );
  });
}

function generatedKnowledgeFolder(record) {
  return record.knowledgeManaged ? record.knowledgeFolder : record.conversationKnowledgeFolder;
}

// An update has to merge, and merging needs what is already there. The other
// hosts print a target and let the model go read the files itself; here the plan
// carries them inline, so drafting a merged update is one round trip instead of
// one plus a file read per knowledge file.
async function renderUpdatePlan(target) {
  const routing = await readRouting();
  const useWhen = routing.cards[target.id]?.useWhen || target.routingDescription;
  const folder = generatedKnowledgeFolder(target);
  const { files } = await listKnowledgeFiles(folder, { limit: 60 });

  const lines = [
    "Save action: update",
    `Context name: ${target.name}`,
    `targetId: ${target.id}`,
    `baseHash: ${await fingerprintContext(target)}`,
    `Routing description: ${useWhen || "(none — derive one from the profile)"}`,
    target.knowledgeManaged
      ? "Knowledge ownership: this context owns its knowledge folder."
      : `Knowledge ownership: the linked folder (${target.knowledgeFolder}) is read-only. ` +
        "Conversation knowledge is bundle-local.",
    "",
    "Pass `targetId` and `baseHash` back verbatim. `knowledge` must be the complete " +
      "post-update contents of the generated conversation-knowledge folder, not just the " +
      "files you changed.",
    "",
    "## Existing domain profile",
    "",
    (await readProfileText(target)) ?? "(none)"
  ];

  lines.push("", "## Existing conversation knowledge", "");
  if (files.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const file of files) {
      const body = await readFile(path.join(folder, ...file.split("/")), "utf8").catch(
        () => "(unreadable)"
      );
      lines.push(`### ${file}`, "", body, "");
    }
  }
  return lines.join("\n");
}

// Decides whether this save creates or updates, and returns everything needed to
// draft it. Deliberately stricter about names than `use_context`: an exact,
// case-insensitive name updates, while a genuinely new name creates. Partial
// matching would turn "save as" into a surprising mutation.
export async function saveTarget(query = "") {
  const state = await loadState();

  if (query.trim().length === 0) {
    if (state.connected?.record) {
      return renderUpdatePlan(state.connected.record);
    }
    if (state.selection) {
      return (
        "Save action: unavailable\n" +
        `The connected context "${state.selection.contextName}" no longer exists on disk.\n` +
        "Connect another context or provide a new context name."
      );
    }
    return (
      "Save action: create\n" +
      "Context name: derive a short, specific name from the conversation."
    );
  }

  const candidates = [...state.contexts];
  if (state.selection && !candidates.some((context) => context.id === state.selection.contextId)) {
    candidates.push({
      id: state.selection.contextId,
      name: state.selection.contextName,
      missing: true
    });
  }

  const exact = candidates.filter((context) => saveNameKey(context.name) === saveNameKey(query));
  if (exact.length > 1) {
    return [
      "Save action: choose",
      `More than one context is named "${query}".`,
      ...exact.map((context) => `  ${context.name}`),
      "Choose a distinct new name or resolve the duplicate before saving."
    ].join("\n");
  }
  if (exact.length === 1) {
    const target = exact[0];
    if (target.missing) {
      return (
        "Save action: unavailable\n" +
        `The context "${target.name}" no longer exists on disk.\n` +
        "Choose a new context name or connect another context."
      );
    }
    return renderUpdatePlan(target);
  }

  const similar = similarSaveTargets(candidates, query);
  if (similar.length > 0) {
    return [
      "Save action: choose",
      `No context is named exactly "${query}", but these names are similar:`,
      ...similar.map((context) => `  ${context.name}`),
      `Confirm whether to create "${query}", or use an exact existing name to update it.`
    ].join("\n");
  }

  return `Save action: create\nContext name: ${query}`;
}

function formatChangedFiles(label, files) {
  return files.length === 0 ? [] : [`  ${label}: ${files.join(", ")}`];
}

// Where this session stands once the save has landed. An unconnected session
// adopts what it just wrote; a connected one is told, in the same breath as the
// `use` line, that it was left alone on purpose.
async function saveConnectionLines(record) {
  const outcome = await connectAfterSave(record).catch(() => null);
  if (outcome?.connected) {
    return [
      `Connected context: ${record.name}`,
      "This session had no context connected, so it is now grounded in the one it just " +
        "saved. Your next messages will use its domain profile and knowledge folder."
    ];
  }
  const lines = [`Connect it with: /neatcontext-use ${record.name}`];
  if (outcome && outcome.contextId !== record.id) {
    lines.push(
      `This session stays connected to "${outcome.contextName}" — a save records work, ` +
        "it does not switch the context you are working in."
    );
  }
  return lines;
}

function renderUpdatePreview(preview) {
  const { record, changes } = preview;
  const lines = [
    `Update the "${record.name}" context?`,
    `  Domain profile: ${preview.profileChanged ? "changed" : "unchanged"}`,
    `  Routing description: ${preview.routingChanged ? "changed" : "unchanged"}`,
    `  Knowledge files: ${changes.added.length} added, ${changes.updated.length} updated, ` +
      `${changes.removed.length} removed`,
    ...formatChangedFiles("Add", changes.added),
    ...formatChangedFiles("Update", changes.updated),
    ...formatChangedFiles("Remove", changes.removed)
  ];
  if (!record.knowledgeManaged) {
    lines.push(`  Linked knowledge folder will not be modified: ${record.knowledgeFolder}`);
  }
  lines.push(
    "Show this to the user and wait. Call this tool again with `confirm: true` only after " +
      "they agree."
  );
  return lines.join("\n");
}

// One tool, three phases, because the alternative is three tools whose schemas
// all sit in the system prompt for the whole session:
//
//   no profile            -> plan: create or update, with what to merge into
//   profile, no confirm   -> create outright, or preview the update
//   profile + confirm     -> apply the update
//
// The capture arrives as arguments rather than through a scratch file: the other
// hosts write JSON to disk and shell out to a CLI because their plugin runs in a
// different process, and this one does not.
export async function saveContext(args = {}) {
  const {
    name,
    targetId,
    baseHash,
    profile,
    routingDescription,
    routingQuestions,
    routingEntities,
    knowledge,
    confirm
  } = args;

  if (typeof profile !== "string" || profile.trim().length === 0) {
    return saveTarget(typeof name === "string" ? name : "");
  }

  const capture = {
    schema: 1,
    name: typeof name === "string" ? name : "",
    profile,
    routingDescription: typeof routingDescription === "string" ? routingDescription : "",
    knowledge: Array.isArray(knowledge) ? knowledge : []
  };
  // Left off the capture entirely when the caller said nothing, so an update
  // leaves whatever is stored alone rather than clearing it.
  if (routingQuestions !== undefined) capture.routingQuestions = routingQuestions;
  if (routingEntities !== undefined) capture.routingEntities = routingEntities;

  try {
    if (typeof targetId === "string" && targetId.length > 0) {
      capture.targetId = targetId;
      capture.baseHash = typeof baseHash === "string" ? baseHash : "";
      const preview = await previewCapturedContextUpdate(capture);
      if (!preview.changed) {
        return `The capture does not change the "${preview.record.name}" context.`;
      }
      if (confirm !== true) {
        return renderUpdatePreview(preview);
      }
      const result = await updateCapturedContext({
        ...capture,
        updatedFrom: "pi-conversation"
      });
      await putCard(result.record.id, {
        useWhen: result.routingDescription,
        source: result.profileText
      }).catch(() => undefined);
      return [
        `Updated context: ${result.record.name}`,
        `Context folder: ${result.record.directory}`,
        `Profile path: ${result.record.profilePath}`,
        `Knowledge folder: ${result.record.knowledgeFolder}`,
        ...(result.record.knowledgeManaged
          ? []
          : [`Conversation knowledge folder: ${result.record.conversationKnowledgeFolder}`]),
        ...(await saveConnectionLines(result.record))
      ].join("\n");
    }

    const result = await createCapturedContext({
      ...capture,
      capturedFrom: "pi-conversation"
    });
    await putCard(result.record.id, {
      useWhen: result.routingDescription,
      source: result.profileText
    }).catch(() => undefined);
    return [
      `Saved context: ${result.record.name}`,
      `Context folder: ${result.record.directory}`,
      `Profile path: ${result.record.profilePath}`,
      `Knowledge folder: ${result.record.knowledgeFolder}`,
      ...(await saveConnectionLines(result.record))
    ].join("\n");
  } catch (error) {
    if (error instanceof ContextError) {
      return error.message;
    }
    throw error;
  }
}
