// NeatContext plugin MCP server for Claude Code.
//
// Behaviors kept from the Claude Code bridge:
//   * this process outlives the session it was spawned in — /clear starts a new
//     one without restarting it — so the host session is re-resolved before
//     every message rather than read once from the environment. Without that,
//     the bridge goes on serving the pre-/clear session's context while the
//     slash commands write the new one's.
//   * initialize advertises tools.listChanged, and we poll the selected
//     context so the host refreshes its tool list when the user runs
//     /neatcontext:use (or the session routes itself).
//   * the routing tools (use_context, preview_context) let the session switch
//     between contexts, under the same auto/ask/manual policy.
//   * a selection whose context was deleted out-of-band is reported by
//     get_context instead of silently vanishing.

import readline from "node:readline";
import { publishSessionId, refreshSessionId } from "./session.mjs";
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
import { createRoutingIndex } from "../core/routing-candidates.mjs";
import { applySelection, resolveContext } from "../core/selection.mjs";

const SERVER_INFO = { name: "neatcontext", version: "0.3.2" };
const GET_CONTEXT_TOOL = {
  name: "get_context",
  title: "Get Context",
  description:
    "Get the connected NeatContext Context: domain profile files to read, and local " +
    "knowledge folders to search. Call this before answering anything that depends on the " +
    "user's own domain, documents, tools, or team conventions — some hosts do not surface " +
    "this server's initialize instructions, so the tool description is what carries that rule.",
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

const NOTHING_CONNECTED =
  `${NOTHING_CONNECTED_HEAD} Connect one with \`/neatcontext:use\`, save this conversation as ` +
  "a new one with `/neatcontext:save`, or create one from a folder of documents with " +
  "`/neatcontext:create`. Until then, do not answer from general knowledge.";

const NOTHING_EXISTS =
  `${NOTHING_CONNECTED_HEAD} There are none on this machine yet, so \`/neatcontext:use\` has ` +
  "nothing to list. Save the work in this conversation as the first one with " +
  "`/neatcontext:save` — it needs no folder and nothing else installed — or point " +
  "`/neatcontext:create` at a folder of docs, runbooks, or TSGs you already have. Until then, " +
  "do not answer from general knowledge.";

// How connecting works in the plugin.
const CONNECTION_RULE = `## Connecting a context, in Claude Code

Contexts are connected from this session and nowhere else: the \`use_context\` tool, or \`/neatcontext:use <name>\` run by the user. \`/neatcontext:disconnect\` disconnects the current one from this session. New ones are made from here too: \`/neatcontext:save\` turns the work in this conversation into one, and \`/neatcontext:create\` builds one around a folder of documents the user already has.

There is no Desktop connection right now. Contexts are stored by this plugin. When the connected context is the wrong one, or none is connected, name the one you need and offer to switch to it here.`;

// The two tools that let a session change what it is grounded in. They are the
// plugin's whole routing mechanism: there is no model in any process here, so
// the session's own model does the routing, from the menu these tools act on.
const USE_CONTEXT_TOOL = {
  name: "use_context",
  title: "Switch Context",
  description:
    "Switch this session to a different NeatContext Context, then call get_context and " +
    "answer from what it returns. Name the context exactly as the routing menu lists it. " +
    "In ask mode this only succeeds once the user has agreed — set `requested` then. Set " +
    "`declined` instead of switching when the user turns a suggested switch down, so it is " +
    "not suggested again.",
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
- Only if it reports that nothing is connected, say so, and offer the way forward it names — connecting an existing context with /neatcontext:use, saving this conversation as a new one with /neatcontext:save, or building one from a folder of documents with /neatcontext:create. Which of those actually applies depends on what exists right now, so relay what the tool says rather than guessing from this text.`;

function writeLine(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

// --- Context source: answers locally, from disk ------------------------------

async function listAllContexts() {
  return { contexts: await listContexts() };
}

// Resolved per call, never fixed at startup: the user can create or save the
// first context mid-session, and the next get_context has to stop telling them
// they have none.
async function nothingConnectedText() {
  const { contexts } = await listAllContexts().catch(() => ({ contexts: [] }));
  return contexts.length === 0 ? NOTHING_EXISTS : NOTHING_CONNECTED;
}

// The selected context, or null when nothing is selected. A selection
// whose context was deleted out-of-band resolves to `missing` so get_context
// can say what happened.
async function activeContext() {
  const selection = await readSelection().catch(() => null);
  if (!selection || selection.available === false) {
    return null;
  }
  const record = await readContext(selection.contextId).catch(() => null);
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

async function contextResponse(message, context) {
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
        content: [{ type: "text", text: await nothingConnectedText() }],
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

// What the model needs to route: every context that exists, one line each on
// what it is for, and the rules for acting on that. Rebuilt on demand rather
// than cached, so `/neatcontext:mode` and a context created mid-session both
// take effect on the next call instead of on the next restart.
// How many contexts a matched request is cut down to, and how many there have
// to be before cutting is worth anything. Below the floor the whole menu is
// already short, so narrowing it would hide contexts to save nothing.
const SHORTLIST_LIMIT = 5;
const SHORTLIST_MIN_CONTEXTS = 8;

// One index for this process, which outlives the session it was spawned in.
// That is the point: it is rebuilt when the contexts change, not per question.
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
  const shortlist = await shortlistFor(contexts, state, entries, query);
  return shortlist ? renderShortlist(shortlist, options) : renderMenu(entries, options);
}

// A shortlist needs three things: a request to match against, enough contexts
// that narrowing gains anything, and at least one that actually matched. Any of
// them missing and the full menu goes out instead — a session is never left
// with less to work with than it has today.
async function shortlistFor(contexts, state, entries, query) {
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    entries.length < SHORTLIST_MIN_CONTEXTS
  ) {
    return null;
  }
  const ranked = await rankContexts(contexts, state, query, { limit: SHORTLIST_LIMIT });
  if (ranked.length === 0) {
    return null;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return ranked.map((result) => ({ ...byId.get(result.id), matched: result.matched }));
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
  const { contexts } = await listAllContexts();
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

// Re-resolve which session this process is serving, and publish the answer so a
// slash command can tell whether its write is the one this bridge will read.
async function syncSession() {
  await refreshSessionId();
  await publishSessionId();
}

// What the host's tool list depends on. Switching between contexts has to
// change this; so does the routing mode, because leaving manual has to make the
// routing tools appear without waiting for a restart.
async function currentVersion() {
  // The session is part of it: `/clear` changes what this process is grounded
  // in without changing anything the selection or the mode can report, and the
  // host has to be told to drop the previous session's extension tools.
  const session = sessionId() ?? "none";
  const mode = resolveMode(await readRouting(), sessionId());
  const context = await activeContext();
  // The extension signature is read from what the last resolve found, never by
  // starting anything: this runs on a timer, and a poll must not spawn a server.
  const extensions = extensionHost.signature(context?.record ?? null);
  if (context) {
    return `${session}/${mode}/${context.missing ? "context:missing" : context.record.id}/${extensions}`;
  }
  return `${session}/${mode}/none/${extensions}`;
}

async function handleMessage(message) {
  const isNotification = message.id === undefined || message.id === null;
  // Before anything reads a selection or a routing mode: which session this
  // host is on may have changed since the last message, and every one of those
  // is per session.
  await syncSession();

  // Routing tools decide which context serves the session next, so they are
  // answered before that choice is read.
  if (message.method === "tools/call" && ROUTING_TOOLS.has(message.params?.name)) {
    writeLine(await routingToolCall(message));
    return;
  }

  const context = await activeContext();
  if (dependsOnExtensions(message)) {
    await refreshExtensions(context);
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

  const response = await contextResponse(message, context);

  if (message.method === "initialize" && response && response.result) {
    started = true;
    lastVersion = await currentVersion();
    startVersionWatch();
  }

  if (!isNotification && response) {
    writeLine(await shapeResponse(message, response));
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
async function pluginNotes(query) {
  const menu = await routingMenu(query);
  return menu ? `${menu}\n\n${CONNECTION_RULE}` : CONNECTION_RULE;
}

async function withNotes(response, place, query) {
  const notes = await pluginNotes(query);
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

async function shapeResponse(message, response) {
  if (message.method === "initialize" && response.result) {
    return withNotes(response, "instructions");
  }
  if (message.method === "tools/list") {
    return await withRoutingTools(response);
  }
  if (message.method === "tools/call" && message.params?.name === GET_CONTEXT_TOOL.name) {
    // The handshake has no request to match against, so only this path can
    // narrow the menu — which is also the path that is re-read every turn.
    return withNotes(response, "content", message.params?.arguments?.query);
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
    // The host does not send a message when the user runs `/clear`, so this tick
    // is where a session change is noticed if nothing else asks first — and
    // where the published answer stays fresh enough to be checked against.
    await syncSession();
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
