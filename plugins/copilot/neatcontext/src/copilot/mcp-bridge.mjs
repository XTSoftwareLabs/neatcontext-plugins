// NeatContext plugin MCP server for GitHub Copilot.
//
// Behaviors kept from the Claude Code bridge:
//   * initialize advertises tools.listChanged, and we poll the selected
//     context so the host refreshes its tool list when the user runs
//     /neatcontext:use (or the session routes itself).
//   * the routing tools (use_context, preview_context) let the session switch
//     between contexts, under the same auto/ask/manual policy.
//   * a selection whose context was deleted out-of-band is reported by
//     get_context instead of silently vanishing.

import readline from "node:readline";
import { hasHostSessionId } from "./session.mjs";
import { readSelection } from "../core/local-state.mjs";
import {
  CONTEXT_MISSING_MESSAGE,
  listKnowledgeFiles,
  listContexts,
  readContext,
  renderContext
} from "../core/context-store.mjs";
import { createExtensionHost, renderExtensionStatus } from "../core/extension-runtime.mjs";
import { parseQualifiedToolName } from "../core/extensions.mjs";
import {
  addAlias,
  menuEntries,
  noteDecision,
  noteDeclined,
  readRouting,
  renderMenu,
  renderShortlist,
  resolveMode,
  sessionId,
  switchPolicy
} from "../core/routing.mjs";
import {
  assess,
  createRoutingIndex,
  isConfidentMatch
} from "../core/routing-candidates.mjs";
import { applySelection, resolveContext } from "../core/selection.mjs";

const SERVER_INFO = { name: "neatcontext", version: "0.3.4" };
const GET_CONTEXT_TOOL = {
  name: "get_context",
  title: "Get Context",
  description:
    "Get the connected NeatContext Context: domain profile files to read, and local " +
    "knowledge folders to search. Call this before answering anything that depends on the " +
    "user's own domain, documents, tools, or team conventions — some hosts do not surface " +
    "this server's initialize instructions, so the tool description is what carries that rule. " +
    "Pass the user's request as query before calling use_context: when nothing is connected, " +
    "this tool safely auto-connects a uniquely clear match in auto mode or returns the routing " +
    "menu needed to choose, ask, or decline.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What the user is actually asking about, in their own words. Pass it whenever there " +
          "is one: it decides which of the contexts on this machine are worth showing you, " +
          "instead of listing all of them. Leave it out and you get the full list."
      }
    },
    additionalProperties: false
  }
};
// What to say when a session has nothing to ground in. It is deliberately about
// what to do *here*: every route is a command in this session, and no other
// software is involved.
//
// Two versions, because "pick one of yours" and "you have none yet" are
// different problems. With an empty store `/neatcontext:use` has nothing to
// list, and `/neatcontext:create` wants a folder of documents a new user may
// not have — so a session told only about those two is sent to two doors that
// are both locked. `/neatcontext:save` is the one that always opens: it builds
// the first context out of the conversation already happening. So it leads when
// there is nothing to connect.
const NOTHING_CONNECTED_HEAD = "No NeatContext Context is connected to this session.";

// The manual-mode version, and the fallback whenever no menu follows. Routing
// is off here, so a command the user types is genuinely the only way forward.
const NOTHING_CONNECTED =
  `${NOTHING_CONNECTED_HEAD} Connect one with \`/neatcontext:use\`, save this conversation as ` +
  "a new one with `/neatcontext:save`, or create one from a folder of documents with " +
  "`/neatcontext:create`. Until then, do not answer from general knowledge.";

// What to say instead when routing is on and there are contexts to route to.
//
// Leading with `/neatcontext:use` in that situation is what made routing look
// broken. This text is the first and most imperative thing the model reads, and
// it answered "what now?" with a command for the user to type before the menu
// below ever got a turn — so a question that plainly belonged to a saved
// context came back as an offer to go and connect one by hand. The menu is
// still what carries the mode-specific rules; these two only have to stop
// contradicting it.
//
// Whether automatic matching actually ran is threaded in rather than assumed.
// This text is reached with no query at all, on a stale selection, and when
// reading the store failed — and on each of those "no safe automatic match was
// made" would be the plugin telling the model that nothing in the store matched
// when nothing was ever compared. That is the same rule the comment above sets
// out for the handshake instructions: text that cannot know the current state
// must not assert it.
function nothingConnectedRoutable(assessed) {
  return (
    `${NOTHING_CONNECTED_HEAD} There are contexts on this machine, listed below with what each ` +
    "one is for. " +
    (assessed ? "No safe automatic match was made for this call. " : "") +
    "Follow the routing rules below: connect a clear choice with `use_context`, ask when the " +
    "choice is ambiguous, or say none covers the request. Do not ask the user to run a command " +
    "to connect a context you can already name. If none covers the request, offer " +
    "`/neatcontext:save` to make one out of this conversation. Until then, do not answer from " +
    "general knowledge."
  );
}

const NOTHING_CONNECTED_ASK =
  `${NOTHING_CONNECTED_HEAD} There are contexts on this machine, listed below with what each ` +
  "one is for. Routing is in ask mode, so name the one this request belongs to and ask whether " +
  "to connect it rather than connecting first. If none of them covers the request, say so and " +
  "offer `/neatcontext:save` to make one out of this conversation. Until then, do not answer " +
  "from general knowledge.";

const NOTHING_EXISTS =
  `${NOTHING_CONNECTED_HEAD} There are none on this machine yet, so \`/neatcontext:use\` has ` +
  "nothing to list. Save the work in this conversation as the first one with " +
  "`/neatcontext:save` — it needs no folder and nothing else installed — or point " +
  "`/neatcontext:create` at a folder of docs, runbooks, or TSGs you already have. Until then, " +
  "do not answer from general knowledge.";

// How connecting works in the plugin.
const CONNECTION_RULE = `## Connecting a context, in GitHub Copilot

Contexts are connected from this session and nowhere else: the \`use_context\` tool, or \`/neatcontext:use <name>\` run by the user. \`/neatcontext:disconnect\` disconnects the current one from this session. New ones are made from here too: \`/neatcontext:save\` turns the work in this conversation into one, and \`/neatcontext:create\` builds one around a folder of documents the user already has.

There is no Desktop connection right now. Contexts are stored by this plugin. When a request may need a context, call \`get_context\` with the user's request before \`use_context\`. With nothing connected, it safely auto-connects a uniquely clear match in auto mode; otherwise it returns the current routing menu. Use \`use_context\` only to act on that menu, switch a wrong connection, or honor an explicit user choice — and ask first when the routing rules say to ask.`;

// The two tools that let a session change what it is grounded in. They are the
// plugin's whole routing mechanism: there is no model in any process here, so
// the session's own model does the routing, from the menu these tools act on.
const USE_CONTEXT_TOOL = {
  name: "use_context",
  title: "Switch Context",
  description:
    "Act on a routing menu returned by get_context, switch a wrong connection, or honor an " +
    "explicit user choice; do not call this before get_context when routing a new request. " +
    "After switching, call get_context and answer from what it returns. Name the context " +
    "exactly as the routing menu lists it. In ask mode this only succeeds once the user has " +
    "agreed — set `requested` then. Set `declined` instead of switching when the user turns a " +
    "suggested switch down, so it is not suggested again.",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string", description: "The context to switch to, by name." },
      reason: {
        type: "string",
        description: "One phrase: what in the request makes this the right context."
      },
      requested: {
        type: "boolean",
        description: "The user asked for this context by name, or agreed to the switch."
      },
      declined: {
        type: "boolean",
        description: "The user turned this switch down. Records it and switches nothing."
      },
      alias: {
        type: "string",
        description:
          "What the user called this context or subject when correcting a wrong route. " +
          "Remembered so the same words route correctly next time."
      }
    },
    required: ["context"],
    additionalProperties: false
  }
};

const PREVIEW_CONTEXT_TOOL = {
  name: "preview_context",
  title: "Preview Context",
  description:
    "Look closer at a context before switching, when two of them are plausible and the " +
    "routing menu is not enough to choose. Returns what the context covers and what is in " +
    "its knowledge folder. Read-only: it changes nothing.",
  inputSchema: {
    type: "object",
    properties: { context: { type: "string", description: "The context to preview, by name." } },
    required: ["context"],
    additionalProperties: false
  }
};

const ROUTING_TOOLS = new Map([
  [USE_CONTEXT_TOOL.name, USE_CONTEXT_TOOL],
  [PREVIEW_CONTEXT_TOOL.name, PREVIEW_CONTEXT_TOOL]
]);

// Session instructions are fetched once, during the handshake, and MCP has no
// way to change them afterwards. Anything that varies per context belongs in
// get_context instead, which is re-read on every call and refreshed live by
// tools/list_changed. These instructions do one job: get get_context called at
// the right moments.
const CONTEXT_INSTRUCTIONS = `This session can be grounded in a NeatContext Context: one domain profile and local knowledge stored on this machine.

Call the get_context tool before answering anything that depends on the user's own domain, documents, tools, or team conventions — it returns the profile file to read and the knowledge folder to search. Read the profile in full: it states what the context is for, what to do, what to avoid, and how to behave, and it is your primary behavioral guide for this session.

A context is whatever its profile says it is. Do not assume a subject area for it, and do not impose a response format it does not ask for.

Cite the exact file path of anything you rely on. When the profile and the knowledge folder do not cover the question, say so instead of answering from general knowledge.`;

// Written to survive being wrong. These instructions are fixed at the
// handshake, but a context can be connected at any time afterwards — from this
// session or from another window on the same workspace. So this must never
// state "nothing is connected" as a settled fact; it defers the current state
// to get_context, which is the only thing that stays true.
const NO_CONTEXT_INSTRUCTIONS = `No NeatContext Context was connected at the moment this session started. That says nothing about now: a Context can be connected at any time, from this session or another window on this workspace.

These instructions are fixed at the handshake and cannot be updated, so they are not evidence about the current state — and you must not tell the user nothing is connected on the strength of this text.

When the user asks anything that depends on their own domain, documents, tools, or team conventions, call the get_context tool and let its answer decide:

- If it returns a Context, ground your answer in it and cite what you used.
- Pass the user's request as query. If nothing is connected, get_context safely auto-connects a uniquely clear match in auto mode or returns the current routing menu.
- If it still reports that nothing is connected, follow that returned menu: use use_context only for its clear choice, ask the user when required, or say no context covers the request. It knows the current state and this text does not, so never substitute a slash command of your own for the route it offers.`;

function writeLine(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

// --- Context source: answers locally, from disk ------------------------------

// Resolved per call, never fixed at startup: the user can create or save the
// first context mid-session, and the next get_context has to stop telling them
// they have none. The mode is read here for the same reason — it decides
// whether a menu is about to follow this text, and therefore whether pointing
// at a slash command is the honest answer or the one that breaks routing.
//
// The routing pass this call already made is passed in rather than re-read,
// and it is also what says whether automatic matching ran at all.
async function nothingConnectedText(pass) {
  const contexts = pass?.contexts ?? (await listContexts().catch(() => []));
  if (contexts.length === 0) {
    return NOTHING_EXISTS;
  }
  const state = pass?.state ?? (await readRouting().catch(() => ({ sessions: {} })));
  const mode = resolveMode(state, sessionId());
  if (mode === "manual") {
    return NOTHING_CONNECTED;
  }
  return mode === "ask" ? NOTHING_CONNECTED_ASK : nothingConnectedRoutable(pass?.assessed === true);
}

// The selected context, or null when nothing is selected. A selection
// whose context was deleted out-of-band resolves to `missing` so get_context
// can say what happened.
//
// A context this call just connected is passed straight through: it was read
// out of the same listing a moment ago, and re-reading the selection file only
// to look it up again would be two disk hits to learn what is already in hand.
// The same listing answers the ordinary case, so a call that made one pass over
// the store makes exactly one.
async function activeContext(pass) {
  if (pass?.connected) {
    return { record: pass.connected };
  }
  const selection = pass ? pass.selection : await readSelection().catch(() => null);
  if (!selection || selection.available === false) {
    return null;
  }
  const record = pass
    ? (pass.contexts.find((context) => context.id === selection.contextId) ?? null)
    : await readContext(selection.contextId).catch(() => null);
  return record ? { record } : { missing: true, name: selection.contextName };
}

// --- Extensions: what the connected context can reach --------------------------

// One host for the life of this process. It caches a connection per extension
// and drops every one of them when the session switches context, so a tool
// belonging to a context this session has left is never callable.
const extensionHost = createExtensionHost();
let extensionTools = [];
let extensionStatuses = [];

// Resolved before answering anything that depends on it, rather than on a timer:
// starting a user's extension server is not something to do speculatively.
async function refreshExtensions(context) {
  const record = context && !context.missing ? context.record : null;
  const resolved = await extensionHost.resolve(record).catch(() => ({ statuses: [], tools: [] }));
  extensionTools = resolved.tools;
  extensionStatuses = resolved.statuses;
}

function dependsOnExtensions(message) {
  return (
    message.method === "tools/list" ||
    (message.method === "tools/call" && typeof message.params?.name === "string")
  );
}

async function contextResponse(message, context, pass = null) {
  const { id, method, params } = message;
  if (id === undefined || id === null) {
    return null; // notification: nothing to answer
  }
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
      serverInfo: SERVER_INFO,
      instructions: context ? CONTEXT_INSTRUCTIONS : NO_CONTEXT_INSTRUCTIONS
    });
  }
  if (method === "ping") return jsonRpcResult(id, {});
  // get_context is the whole grounding surface. Beside it sit whichever tools
  // the connected context declared and this machine actually provides — none,
  // usually, and never any that outlive the context they belong to.
  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: [GET_CONTEXT_TOOL, ...extensionTools] });
  }
  if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });
  if (method === "tools/call" && params?.name === GET_CONTEXT_TOOL.name) {
    if (!context) {
      return jsonRpcResult(id, {
        content: [{ type: "text", text: await nothingConnectedText(pass) }],
        isError: false
      });
    }
    const text = context.missing
      ? CONTEXT_MISSING_MESSAGE
      : await renderContext(context.record);
    const extensions = renderExtensionStatus(extensionStatuses);
    return jsonRpcResult(id, {
      content: [{ type: "text", text: extensions ? `${text}\n\n${extensions}` : text }],
      isError: false
    });
  }
  if (method === "tools/call" || method === "prompts/get") {
    // Named like an extension tool, but not one this context can reach: either
    // it was never declared, or the extension behind it is not available.
    const qualified = parseQualifiedToolName(params?.name);
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: qualified
          ? `"${params.name}" is not available from the connected context. Its extensions ` +
            "are listed by get_context; answer from the profile and knowledge folder instead."
          : `"${params?.name}" is not available. Contexts serve only get_context.`
      }
    };
  }
  return jsonRpcResult(id, {});
}

// --- Routing: the session picks its own context ------------------------------

// What the model needs to route: the contexts worth considering, one line
// each on what they are for, and the rules for acting on that. Rebuilt on demand rather
// than cached, so `/neatcontext:mode` and a context created mid-session both
// take effect on the next call instead of on the next restart.
// With a request to match against, the menu is the few contexts that matched
// it; without one it is everything, alphabetically, as it has always been.
const SHORTLIST_LIMIT = 5;
const SHORTLIST_MIN_CONTEXTS = 8;

// One index for this process, which outlives the session it was spawned in.
// That is the point: it is rebuilt when the contexts change, not per question.
const rankContexts = createRoutingIndex({
  listFiles: async (record) =>
    (await listKnowledgeFiles(record.knowledgeFolder, { limit: 60 })).files
});

async function routingMenu(query, pass) {
  const [contexts, state] = pass
    ? [pass.contexts, pass.state]
    : await Promise.all([listContexts(), readRouting()]);
  const connectedId = pass
    ? (pass.connected?.id ?? pass.selection?.contextId ?? null)
    : ((await readSelection().catch(() => null))?.contextId ?? null);
  const options = { connectedId, mode: resolveMode(state, sessionId()) };
  const entries = menuEntries(contexts, state);
  const shortlist = await shortlistFor(contexts, state, entries, query, connectedId);
  if (shortlist) {
    return renderShortlist(shortlist, { ...options, decision: assess(shortlist) });
  }
  // The full menu carries the tie the pass found, if it found one. A store
  // below SHORTLIST_MIN_CONTEXTS never builds a shortlist, so this is the only
  // way a near-tie the plugin already refused to act on reaches the model at
  // all — and without it the plugin declines, says nothing about why, and the
  // model picks one of the two anyway.
  return renderMenu(entries, { ...options, decision: pass?.decision });
}

// `get_context` is already the session asking the plugin to route this request.
// In auto mode, complete a clear first connection here rather than depending on
// the model to translate the returned shortlist into a second `use_context`
// call. Existing connections are never changed by this shortcut: leaving a
// context still needs the conversational follow-up judgment only the model has.
//
// One pass over the store serves the whole call. What it loads — contexts,
// routing state, the ranking and its verdict — is what the menu and the
// nothing-connected text are built from a moment later, and re-reading it there
// made every `get_context` with a query hit the disk three times over for the
// same answer.
//
// The confidence rule itself lives in core beside `assess`, not here. Copilot
// is the first host to act on it and for now the only one; the other four share
// this machine's `~/.neatcontext` and keep the old behavior until they are
// wired up too, which is a staged rollout rather than a permanent split.
async function routingPass(query) {
  const asked = typeof query === "string" && query.trim().length > 0;
  const id = sessionId();
  const selection = await readSelection().catch(() => null);
  const [contexts, state] = await Promise.all([
    listContexts().catch(() => []),
    readRouting().catch(() => ({ sessions: {}, cards: {} }))
  ]);
  const pass = { contexts, state, selection, connected: null, decision: null, assessed: false };

  // Everything that stops the pass before it ranks anything, in one place, so
  // `assessed` stays a statement about what actually happened.
  //
  // A selection carrying a `contextId` covers both "already connected" and
  // "pointed at a context that is gone, and `readSelection` just cleared the
  // file". The second is deliberate: a user whose context vanished should be
  // told that, not silently re-grounded in a different one on the next answer.
  if (
    !asked ||
    selection?.contextId ||
    contexts.length === 0 ||
    resolveMode(state, id) !== "auto" ||
    // Without a session id published by the host, one selection file is shared
    // by every window open on this workspace. A model or a user calling
    // `use_context` at least announces the switch; a keyword hit in one window
    // would silently re-ground the conversation in the next.
    !hasHostSessionId()
  ) {
    return pass;
  }

  // Every candidate, not a top slice: the tie check is only as good as the
  // field it can see.
  //
  // Everything from here is inside one guard. An auto-connection that cannot be
  // made is a missed optimization, and that is all it may ever cost — unguarded,
  // a home this process cannot write to turned every `get_context` in the
  // session into a request that is never answered at all: the write rejected,
  // `main` swallowed it, and nothing was written to stdout.
  try {
    const ranked = await rankContexts(contexts, state, query, {
      limit: contexts.length,
      connectedId: null
    });
    pass.decision = assess(ranked);
    pass.assessed = true;
    if (pass.decision.verdict !== "clear") {
      return pass;
    }

    const leader = ranked[0];
    const target = contexts.find((context) => context.id === leader.id);
    if (!target || !isConfidentMatch(leader, query, { aliases: aliasesOf(state, target.id) })) {
      return pass;
    }

    // Mode was checked above to avoid ranking for nothing; this is the
    // authority on whether the switch itself is allowed, declines included.
    const policy = switchPolicy(state, { id, targetId: target.id, connectedId: null });
    if (!policy.allowed) {
      return pass;
    }

    await applySelection(target);
    await noteDecision({
      sessionId: id,
      from: null,
      to: target.name,
      mode: policy.mode,
      reason: `clear query match: ${leader.matched.join(", ")}`,
      requested: false,
      automatic: true
    });
    pass.connected = target;
  } catch {
    return pass;
  }
  return pass;
}

function aliasesOf(state, contextId) {
  return state.cards?.[contextId]?.aliases ?? [];
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

function toolText(id, text, isError = false) {
  return jsonRpcResult(id, { content: [{ type: "text", text }], isError });
}

async function previewContext(id, target) {
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
  lines.push("", `Switch to it with use_context, or stay where you are.`);
  return toolText(id, lines.join("\n"));
}

async function routingToolCall(message) {
  const { id, params } = message;
  const query = typeof params?.arguments?.context === "string" ? params.arguments.context : "";
  const contexts = await listContexts();
  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    return toolText(
      id,
      `No single context matched "${query}". The contexts are: ` +
        `${contexts.map((context) => context.name).join(", ") || "(none)"}.`,
      true
    );
  }
  const target = resolution.context;
  if (params.name === PREVIEW_CONTEXT_TOOL.name) {
    return previewContext(id, target);
  }

  const args = params.arguments ?? {};
  if (args.declined === true) {
    await noteDeclined(target.id);
    return toolText(
      id,
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
    return toolText(id, refusal(policy, target), true);
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

  return toolText(
    id,
    `Switched this session to "${result.name}".` +
      (alias ? ` "${alias}" will route here from now on.` : "") +
      " Call get_context now and answer from what it returns. Tell the user in one line that " +
      "you switched, and to what."
  );
}

function refusal(policy, target) {
  if (policy.reason === "already-connected") {
    return `"${target.name}" is already the connected context. Nothing to switch.`;
  }
  if (policy.reason === "manual-mode") {
    return (
      "Context routing is off (manual mode). Do not switch. If the answer needs a different " +
      `context, tell the user to run \`/neatcontext:use ${target.name}\`.`
    );
  }
  if (policy.reason === "declined-this-session") {
    return (
      `The user already declined switching to "${target.name}" in this session. Do not ask ` +
      "again — answer with the context that is connected, or say what it cannot cover."
    );
  }
  return (
    `Context routing is in ask mode, so nothing has changed yet. Ask the user whether to ` +
    `switch to "${target.name}", say briefly why it looks like the right one, and call this ` +
    "tool again with `requested: true` only if they agree."
  );
}

// --- Server loop --------------------------------------------------------------

let started = false;
let lastVersion = undefined;

// What the host's tool list depends on. Switching between contexts has to
// change this; so does the routing mode, because leaving manual has to make the
// routing tools appear without waiting for a restart.
async function currentVersion() {
  const mode = resolveMode(await readRouting(), sessionId());
  const context = await activeContext();
  // The extension signature is read from what the last resolve found, never by
  // starting anything: this runs on a timer, and a poll must not spawn a server.
  const extensions = extensionHost.signature(context?.record ?? null);
  if (context) {
    return `${mode}/${context.missing ? "context:missing" : context.record.id}/${extensions}`;
  }
  return `${mode}/none/${extensions}`;
}

async function handleMessage(message) {
  const isNotification = message.id === undefined || message.id === null;

  // Routing tools decide which context serves the session next, so they are
  // answered before that choice is read.
  if (message.method === "tools/call" && ROUTING_TOOLS.has(message.params?.name)) {
    writeLine(await routingToolCall(message));
    return;
  }

  const isGetContext =
    message.method === "tools/call" && message.params?.name === GET_CONTEXT_TOOL.name;
  const pass = isGetContext ? await routingPass(message.params?.arguments?.query) : null;
  const context = await activeContext(pass);
  // Extensions are deliberately not resolved on the turn that auto-connected.
  // Resolving one starts the user's own server, and this is the one connection
  // nobody asked for out loud: the announcement goes out first, and anything
  // bound to the context starts on the next call that actually needs it.
  if (dependsOnExtensions(message) && !pass?.connected) {
    await refreshExtensions(context);
  } else if (pass?.connected) {
    extensionTools = [];
    extensionStatuses = [];
  }

  // An extension tool, proxied to the server the user bound for it. Answered
  // before the context surface, which knows only about get_context.
  if (message.method === "tools/call" && parseQualifiedToolName(message.params?.name)) {
    const result = await extensionHost.call(message.params.name, message.params.arguments);
    if (result) {
      writeLine(jsonRpcResult(message.id, result));
      return;
    }
  }

  const response = await contextResponse(message, context, pass);

  if (message.method === "initialize" && response && response.result) {
    started = true;
    lastVersion = await currentVersion();
    startVersionWatch();
  }

  if (!isNotification && response) {
    writeLine(await shapeResponse(message, response, pass));
  }
}

// What the plugin adds to whichever answer goes out: how connecting works here,
// and the routing menu when there is one. Both ride on both channels on
// purpose. In the handshake, so the session knows what else exists without
// having to call anything; in every get_context result, because that one is
// re-read on every call and the handshake cannot be.
//
// The connection rule goes last, so it is the closest thing to the answer the
// session is about to write — and it is the one part that is never omitted.
async function pluginNotes(query, pass) {
  const menu = await routingMenu(query, pass);
  return menu ? `${menu}\n\n${CONNECTION_RULE}` : CONNECTION_RULE;
}

async function withNotes(response, place, query, pass) {
  const notes = await pluginNotes(query, pass);
  if (place === "instructions") {
    const existing = response.result.instructions;
    return {
      ...response,
      result: {
        ...response.result,
        instructions: typeof existing === "string" ? `${existing}\n\n${notes}` : notes
      }
    };
  }
  const content = response.result?.content;
  if (!Array.isArray(content) || content[0]?.type !== "text") {
    return response;
  }
  return {
    ...response,
    result: {
      ...response.result,
      content: [{ ...content[0], text: `${content[0].text}\n\n${notes}` }, ...content.slice(1)]
    }
  };
}

function prependAutoConnection(response, contextName) {
  if (!contextName || !Array.isArray(response.result?.content) || response.result.content[0]?.type !== "text") {
    return response;
  }
  const content = response.result.content;
  return {
    ...response,
    result: {
      ...response.result,
      content: [
        {
          ...content[0],
          text: `Automatically connected "${contextName}" for this request.\n\n${content[0].text}`
        },
        ...content.slice(1)
      ]
    }
  };
}

async function shapeResponse(message, response, pass = null) {
  if (message.method === "initialize" && response.result) {
    return withNotes(response, "instructions");
  }
  if (message.method === "tools/list") {
    return await withRoutingTools(response);
  }
  if (message.method === "tools/call" && message.params?.name === GET_CONTEXT_TOOL.name) {
    // The handshake has no request to match against, so only this path can
    // narrow the menu — which is also the path that is re-read every turn.
    return prependAutoConnection(
      await withNotes(response, "content", message.params?.arguments?.query, pass),
      pass?.connected?.name ?? null
    );
  }
  return response;
}

// Advertised in every mode but manual, where the absence of the tools is what
// "never route" means — the session cannot switch by mistake because there is
// nothing to call.
async function withRoutingTools(response) {
  if (!Array.isArray(response?.result?.tools)) {
    return response;
  }
  const state = await readRouting();
  if (resolveMode(state, sessionId()) === "manual") {
    return response;
  }
  return {
    ...response,
    result: { ...response.result, tools: [...response.result.tools, ...ROUTING_TOOLS.values()] }
  };
}

let watching = false;
function startVersionWatch() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    if (!started) return;
    const version = await currentVersion();
    if (version !== null && version !== lastVersion) {
      lastVersion = version;
      writeLine({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  }, 1500).unref?.();
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    // Serialize so the initialize handshake and ordering are preserved.
    queue = queue.then(() => handleMessage(message)).catch(() => {});
  });
  // Whatever this session started on its behalf goes with it.
  rl.on("close", () => {
    extensionHost.dispose();
    process.exit(0);
  });
}

main();
