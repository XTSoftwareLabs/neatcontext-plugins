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
  renderContext
} from "../core/context-store.mjs";
import { createExtensionHost, renderExtensionStatus } from "../core/extension-runtime.mjs";
import { parseQualifiedToolName } from "../core/extensions.mjs";
import {
  addAlias,
  DEFAULT_MODE,
  hasLiveDecline,
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
    "this tool can safely auto-connect a uniquely clear match in auto mode, and otherwise " +
    "returns the routing menu needed to choose, ask, or decline.",
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
function nothingConnectedRoutable(assessed, shared) {
  return (
    `${NOTHING_CONNECTED_HEAD} There are contexts on this machine, listed below with what each ` +
    "one is for. " +
    (assessed ? "No safe automatic match was made for this call. " : "") +
    (shared
      ? "Automatic connection is off in this window: this host gives it no session of its own, " +
        "so connecting one here would change what every other window open on this folder is " +
        "grounded in. Connect it yourself with `use_context`. "
      : "") +
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
// The routing pass this call already made is what this is built from, and it
// is also what says whether automatic matching ran at all.
function nothingConnectedText(pass) {
  if (pass.contexts.length === 0) {
    return NOTHING_EXISTS;
  }
  if (pass.mode === "manual") {
    return NOTHING_CONNECTED;
  }
  return pass.mode === "ask"
    ? NOTHING_CONNECTED_ASK
    : nothingConnectedRoutable(pass.assessed, pass.shared);
}

// The selected context, or null when nothing is selected. A selection
// whose context was deleted out-of-band resolves to `missing` so get_context
// can say what happened.
//
// Answered entirely from the pass: the listing it holds was read a moment ago,
// and `readContext` is itself a lookup in that same listing. One resolution
// path rather than two, so there is nowhere for the two to drift apart.
function activeContext(pass) {
  if (pass.connected) {
    return { record: pass.connected };
  }
  if (!pass.connectedId) {
    return null;
  }
  const record = pass.contexts.find((context) => context.id === pass.connectedId) ?? null;
  return record ? { record } : { missing: true, name: pass.selection?.contextName };
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

async function contextResponse(message, context, pass) {
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
        content: [{ type: "text", text: nothingConnectedText(pass) }],
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

function routingMenu(pass) {
  const options = { connectedId: pass.connectedId, mode: pass.mode };
  const entries = menuEntries(pass.contexts, pass.state);
  const shortlist = shortlistFor(entries, pass.ranked);
  // The same verdict either way. A near-tie is a fact about the ranking, not
  // about how much of it is being shown, and a store below
  // SHORTLIST_MIN_CONTEXTS never builds a shortlist at all — so reading it off
  // the shortlist alone left the full menu, the one place the model has least
  // to go on, as the only caller that never heard about it.
  //
  // Assessed again over the shortlist, though, because the tie note names its
  // leaders and the model is asked to say what each one covers. `pass.decision`
  // is over the whole corpus — right for the gate, which needs the full field
  // to know a leader is uncontested, and wrong here: with eight contexts inside
  // the ratio band it named all eight, three of them absent from the list
  // printed directly above, and asked the model to describe contexts it had
  // never been shown. The verdict itself cannot differ — the shortlist is the
  // top of the same ranking, so a leader uncontested in the corpus is
  // uncontested in its prefix — only the names it carries.
  //
  // `renderMenu` needs no such trim: it is reached only below
  // SHORTLIST_MIN_CONTEXTS, where it prints every context there is.
  return shortlist
    ? renderShortlist(shortlist, { ...options, decision: assess(shortlist) })
    : renderMenu(entries, { ...options, decision: pass.decision });
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
// Built for every message, not only the ones that can auto-connect, so there is
// one way to resolve a context rather than a pass-shaped path and a re-reading
// path that have to be kept agreeing with each other. Without a query it stops
// after the reads, which is exactly what the old path did.
//
// Ranking happens whenever there is a request to rank, before any question of
// whether *this* call may act on it: a near-tie is a property of the ranking,
// and the menu needs to say so even when auto-connect was never on the table.
//
// The confidence rule itself lives in core beside `assess`, not here. Copilot
// is the first host to act on it and for now the only one; the other four share
// this machine's `~/.neatcontext` and keep the old behavior until they are
// wired up too, which is a staged rollout rather than a permanent split.
async function routingPass(query) {
  const asked = typeof query === "string" && query.trim().length > 0;
  const pass = {
    contexts: [],
    state: { sessions: {}, cards: {} },
    selection: null,
    connectedId: null,
    mode: DEFAULT_MODE,
    ranked: null,
    decision: null,
    connected: null,
    assessed: false,
    shared: false
  };

  // Everything is inside one guard, starting with `sessionId()` — it reads
  // `process.cwd()`, which throws outright once the working directory has been
  // removed under a long-lived server. An auto-connection that cannot be made
  // is a missed optimization, and that is all any of this may ever cost:
  // unguarded, one rejection here turned every `get_context` in the session
  // into a request that is never answered at all, because `main` swallowed it
  // and nothing was written to stdout.
  try {
    const id = sessionId();
    const selection = await readSelection().catch(() => null);
    const [contexts, state] = await Promise.all([
      listContexts().catch(() => []),
      readRouting().catch(() => ({ sessions: {}, cards: {} }))
    ]);
    pass.selection = selection;
    pass.contexts = contexts;
    pass.state = state;
    pass.mode = resolveMode(state, id);
    // A selection whose context is gone is nothing connected — `readSelection`
    // has just deleted the file — and everything downstream has to agree on
    // that. Read as connected, one response says "no Context is connected"
    // while carrying the guards written for a session that has somewhere to
    // leave, which is the suppression this whole path exists to remove.
    pass.connectedId = selection?.available === false ? null : (selection?.contextId ?? null);

    if (!asked || contexts.length === 0) {
      return pass;
    }

    // Manual is the mode in which the plugin never routes, and both renderers
    // return null for it — `renderMenu` and `renderShortlist` alike — so no
    // reader for a ranking made here exists. Producing one anyway cost a
    // knowledge-folder listing per context, BM25 over the corpus, and a decline
    // lookup and decision-log walk per candidate, on every queried call, to
    // build a list thrown away on the next line.
    if (pass.mode === "manual") {
      return pass;
    }

    // Every candidate, not a top slice: the tie check is only as good as the
    // field it can see. The shortlist takes its own slice of this afterwards
    // rather than ranking the corpus a second time.
    pass.ranked = await rankContexts(contexts, state, query, {
      limit: contexts.length,
      connectedId: pass.connectedId
    });
    pass.decision = assess(pass.ranked);

    // From here it is about acting unasked. `assessed` stays a statement about
    // that specific question, so the nothing-connected text only claims a match
    // was looked for when one actually was.
    if (pass.connectedId || pass.mode !== "auto") {
      return pass;
    }

    // Auto mode with a request to match and nothing connected — everything the
    // feature needs except a window it can call its own. Without a host session
    // id, `sessionId()` is the workspace digest every window on this folder
    // shares, and connecting on that re-grounds the conversation running next
    // door. Recorded rather than just returned: `get_context`'s own description
    // tells the model this call can connect a clear match, and sharing an early
    // return with the mode and connected checks left the one case where that is
    // never true saying nothing at all. Silence there reads as "nothing
    // matched", which is a claim about the store rather than about the host.
    if (!hasHostSessionId()) {
      pass.shared = true;
      return pass;
    }
    pass.assessed = true;
    if (pass.decision.verdict !== "clear") {
      return pass;
    }

    const leader = pass.ranked[0];
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

    // A refusal the user made in another session only discounts the score, and
    // a discount cannot change an outcome the leader was going to win anyway —
    // which in a small store is every outcome. That was survivable while this
    // route went through the model, because calling `use_context` announces the
    // switch and gives the user somewhere to say no again. Acting unasked
    // removes the announcement, so a live refusal disqualifies it outright.
    if (hasLiveDecline(state, target.id)) {
      return pass;
    }

    await applySelection(target);
    // Recorded before the decision log is written, because the selection file
    // is now pointing at the target whatever happens next. Left until after,
    // a `noteDecision` failure produced a pass that said nothing was connected
    // and a disk that said otherwise — and the menu that followed offered the
    // context the session was already on, which `use_context` then refused as
    // "already connected. Nothing to switch."
    pass.connected = target;
    pass.connectedId = target.id;
    await noteDecision({
      sessionId: id,
      from: null,
      to: target.name,
      mode: policy.mode,
      reason: `clear query match: ${leader.matched.join(", ")}`,
      requested: false,
      automatic: true
    });
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
// A slice of the ranking the pass already made, not a second one. Ranking the
// corpus twice per call was the larger half of the work: BM25 over every
// document, then a decline lookup and a walk of the decision log per candidate,
// all to arrive at a prefix of a list that was already in hand.
function shortlistFor(entries, ranked) {
  if (!ranked || ranked.length === 0 || entries.length < SHORTLIST_MIN_CONTEXTS) {
    return null;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // The score travels with the entry because how far ahead the leader is
  // decides whether the shortlist names a winner or asks a question.
  return ranked.slice(0, SHORTLIST_LIMIT).map((result) => ({
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
  const pass = await routingPass();
  const context = activeContext(pass);
  // The extension signature is read from what the last resolve found, never by
  // starting anything: this runs on a timer, and a poll must not spawn a server.
  const extensions = extensionHost.signature(context?.record ?? null);
  if (context) {
    return `${pass.mode}/${context.missing ? "context:missing" : context.record.id}/${extensions}`;
  }
  return `${pass.mode}/none/${extensions}`;
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
  const pass = await routingPass(isGetContext ? message.params?.arguments?.query : undefined);
  const context = activeContext(pass);
  // Extensions are deliberately not resolved on the turn that auto-connected.
  // Resolving one starts the user's own server, and this is the one connection
  // nobody asked for out loud: the announcement goes out first, and anything
  // bound to the context starts on the next call that actually needs it.
  //
  // Deferring the start is not a reason to defer the teardown, though. Dropping
  // the previous context's live clients is the other half of `resolve`, and
  // `extension-runtime` states the invariant absolutely: nothing the previous
  // context started stays reachable from this one. Clearing only the tool and
  // status lists here left the host holding connections a qualified tool name
  // could still be proxied to.
  if (dependsOnExtensions(message) && !pass.connected) {
    await refreshExtensions(context);
  } else if (pass.connected) {
    extensionHost.dispose();
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
async function pluginNotes(pass) {
  const menu = routingMenu(pass);
  return menu ? `${menu}\n\n${CONNECTION_RULE}` : CONNECTION_RULE;
}

async function withNotes(response, place, pass) {
  const notes = await pluginNotes(pass);
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

async function shapeResponse(message, response, pass) {
  if (message.method === "initialize" && response.result) {
    return withNotes(response, "instructions", pass);
  }
  if (message.method === "tools/list") {
    return await withRoutingTools(response);
  }
  if (message.method === "tools/call" && message.params?.name === GET_CONTEXT_TOOL.name) {
    // The handshake has no request to match against, so only this path can
    // narrow the menu — which is also the path that is re-read every turn.
    return prependAutoConnection(
      await withNotes(response, "content", pass),
      pass.connected?.name ?? null
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
