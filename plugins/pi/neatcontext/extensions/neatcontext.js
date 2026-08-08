// NeatContext for pi: the registration layer.
//
// pi has no MCP. Where Claude Code, Codex and Kimi launch this plugin as an MCP
// server beside the agent, pi loads extensions *inside* the agent process — so
// the tools are registered directly here and the logic lives in
// `../src/pi/runtime.mjs`, which imports nothing from pi and is therefore
// testable without one.
//
// Two consequences of that difference are visible in this file:
//
//   * Session identity is free. `ctx.sessionManager.getSessionId()` is right
//     there, so every selection file and routing mode isolates per pi session
//     without the environment-variable plumbing the other hosts need.
//   * The tool list is fixed for the session. `use_context` therefore stays
//     registered and refuses in manual mode.
//
// What pi gives back is a better grounding channel: `before_agent_start` runs
// every turn, so the instructions and routing menu are rebuilt each time rather
// than frozen at a handshake that MCP cannot revise.

import { bindPiSessionId } from "../src/pi/session.mjs";
import {
  commandDisconnect,
  commandExtensions,
  commandList,
  commandMode,
  commandStatus,
  commandUse,
  createContext,
  declareExtension,
  deleteContext,
  describeContext,
  exportContext,
  getContext,
  importContext,
  loadState,
  previewContext,
  saveContext,
  sessionInstructions,
  useContext,
  useExtension
} from "../src/pi/runtime.mjs";

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

const GET_CONTEXT_SCHEMA = {
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
};

function text(value) {
  return { content: [{ type: "text", text: value }], details: undefined };
}

// Registered tools run inside whatever session is active, and `session_start`
// is not the only way a session becomes active — a resumed or forked one can
// reach a tool first. Re-binding from the context each time is cheap and makes
// the session identity impossible to get wrong.
function bindFrom(ctx) {
  try {
    bindPiSessionId(ctx?.sessionManager?.getSessionId?.());
  } catch {
    // A pi mode without a session manager keeps the per-process fallback id.
  }
}

// Command output goes into the session as a visible custom message rather than
// a notification: it is usually several lines, and the model needs to see that
// the context changed as much as the user does.
function report(pi, body) {
  pi.sendMessage({ customType: "neatcontext", content: body, display: true });
}

function splitCommandArguments(input) {
  const words = [];
  let word = "";
  let quote = null;
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word.length > 0) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (word.length > 0) words.push(word);
  return words;
}

function parseExportArguments(input) {
  const words = splitCommandArguments(input);
  const name = [];
  let destination = "";
  let force = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--force") {
      force = true;
    } else if (word === "--to") {
      destination = words[index + 1] ?? "";
      index += 1;
    } else if (word.startsWith("--to=")) {
      destination = word.slice(5);
    } else {
      name.push(word);
    }
  }
  return { context: name.join(" "), destination, force };
}

export default function (pi) {
  // --- grounding ------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    bindFrom(ctx);
  });

  // The whole "which context is this session in" channel, rebuilt per turn.
  // Appended rather than replacing, so other extensions' contributions and pi's
  // own prompt survive.
  pi.on("before_agent_start", async (event, ctx) => {
    bindFrom(ctx);
    try {
      return { systemPrompt: `${event.systemPrompt}\n\n${await sessionInstructions()}` };
    } catch {
      // A corrupt routing file must never stop the turn from running.
      return undefined;
    }
  });

  // --- tools ----------------------------------------------------------------

  pi.registerTool({
    name: "get_context",
    label: "get context",
    description:
      "Get the connected NeatContext Context: domain profile files to read and local " +
      "knowledge folders to search. Call this before answering anything that depends on the " +
      "user's own domain, documents, tools, or team conventions.",
    promptSnippet:
      "get_context: the user's own domain knowledge — call before answering anything that " +
      "depends on their systems, documents, or team conventions.",
    parameters: GET_CONTEXT_SCHEMA,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await getContext(params?.query));
    }
  });

  pi.registerTool({
    name: "use_context",
    label: "switch context",
    description:
      "Switch this session to a different NeatContext Context, then call get_context and " +
      "answer from what it returns. Name the context exactly as the routing menu lists it. " +
      "In ask mode this only succeeds once the user has agreed — set `requested` then. Set " +
      "`declined` instead of switching when the user turns a suggested switch down, so it " +
      "is not suggested again.",
    parameters: {
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
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await useContext(params ?? {}));
    }
  });

  pi.registerTool({
    name: "preview_context",
    label: "preview context",
    description:
      "Look closer at a context before switching, when two of them are plausible and the " +
      "routing menu is not enough to choose. Returns what the context covers and what is in " +
      "its knowledge folder. Read-only: it changes nothing.",
    parameters: {
      type: "object",
      properties: {
        context: { type: "string", description: "The context to preview, by name." }
      },
      required: ["context"],
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await previewContext(params ?? {}));
    }
  });

  pi.registerTool({
    name: "describe_context",
    label: "describe context",
    description:
      "Record what a context should be routed for: one line of scope under 200 characters " +
      "naming its systems, repos, symptoms, ticket prefixes and terminology. Scope only — " +
      "never tone or formatting, since the line is read while other contexts are connected. " +
      "Use `alias` to remember what the user calls it after a wrong route.",
    parameters: {
      type: "object",
      properties: {
        context: { type: "string", description: "The context to describe, by name." },
        useWhen: { type: "string", description: "One line of scope, under 200 characters." },
        alias: { type: "string", description: "What the user calls this context." }
      },
      required: ["context"],
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await describeContext(params ?? {}));
    }
  });

  pi.registerTool({
    name: "neatcontext_save",
    label: "save context",
    description:
      "Save this conversation's durable work as a NeatContext context. Call with only " +
      "`name` (or nothing) first: that returns whether this creates or updates, and for an " +
      "update the existing profile and knowledge to merge into. Then call again with the " +
      "drafted profile and knowledge. Updates preview first and apply on `confirm: true`.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Context name. Omit to use the connected one." },
        targetId: { type: "string", description: "For an update: the targetId from the plan." },
        baseHash: { type: "string", description: "For an update: the baseHash from the plan." },
        profile: {
          type: "string",
          description:
            "The domain profile: `# <name>` then `## Purpose`, `## What to do`, " +
            "`## What to avoid`, `## Behavior`."
        },
        routingDescription: {
          type: "string",
          description: "One line of scope, under 200 characters. Scope only, never behavior."
        },
        routingQuestions: {
          type: "array",
          items: { type: "string" },
          description:
            "10-15 questions this context should catch, in the words a user would type " +
            "rather than the words the profile uses. Matched against, never shown. Omit on " +
            "an update to leave the stored list alone."
        },
        routingEntities: {
          type: "array",
          items: { type: "string" },
          description:
            "Names belonging to the subject that appear rarely elsewhere: services, " +
            "components, repositories, ticket ids and prefixes, error strings, product and " +
            "system names. This travels with the context when it is shared, so no absolute " +
            "paths, home directories, usernames, personal names or email addresses. Matched " +
            "against, never shown. Omit on an update to leave the stored list alone."
        },
        knowledge: {
          type: "array",
          description:
            "The complete contents of the conversation-knowledge folder after this save. " +
            "Always include session-summary.md.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Short relative .md path." },
              content: { type: "string", description: "Markdown body." }
            },
            required: ["path", "content"],
            additionalProperties: false
          }
        },
        confirm: {
          type: "boolean",
          description: "Apply a previewed update. Only after the user has agreed to it."
        }
      },
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await saveContext(params ?? {}));
    }
  });

  pi.registerTool({
    name: "neatcontext_create",
    label: "create context",
    description:
      "Create a NeatContext context around a knowledge folder the user already has. " +
      "The folder is linked read-only and never modified. Use `neatcontext_save` instead to " +
      "capture a conversation.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short, specific context name." },
        knowledgeFolder: {
          type: "string",
          description: "Absolute path to the user's existing knowledge folder."
        },
        profile: {
          type: "string",
          description:
            "The domain profile: `# <name>` then `## Purpose`, `## What to do`, " +
            "`## What to avoid`, `## Behavior`."
        },
        useWhen: {
          type: "string",
          description: "One line of scope, under 200 characters. Scope only, never behavior."
        }
      },
      required: ["name", "knowledgeFolder", "profile"],
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await createContext(params ?? {}));
    }
  });

  // The one place pi's fixed tool list costs something. The MCP hosts register
  // each extension tool under its own name and schema, so the model chooses
  // between them the way it chooses any tool. Here the tool list is settled
  // before any context is connected, so the extensions of whichever context
  // arrives later have to be reached through one proxy — and get_context, which
  // pi rebuilds every turn, is what tells the model their names and arguments.
  pi.registerTool({
    name: "use_extension",
    label: "use extension",
    description:
      "Call one of the connected context's extension tools. get_context lists the exact " +
      "names available and what each one takes; pass one of those as `tool`. Only tools of " +
      "the currently connected context can be called, and only when the user has configured " +
      "that extension on this machine.",
    promptSnippet:
      "use_extension: reach the systems the connected context expects — call get_context " +
      "first to see which of them are available right now.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "The exact tool name from get_context, such as `pagerduty__get_incident`."
        },
        arguments: {
          type: "object",
          description: "The arguments that tool takes, as get_context describes them.",
          additionalProperties: true
        }
      },
      required: ["tool"],
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await useExtension(params ?? {}));
    }
  });

  pi.registerTool({
    name: "neatcontext_declare_extension",
    label: "declare extension",
    description:
      "Record that the connected context expects an extension. This says what capability " +
      "the context wants and travels with it; it configures nothing and connects nothing. " +
      "The user binds a program to that id on each machine themselves.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Short lowercase id for the extension, such as `pagerduty`."
        },
        capability: {
          type: "string",
          description: "One line: what this lets the context do. Under 200 characters."
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Only these tools of that extension. Omit to take whatever it offers."
        },
        important: {
          type: "boolean",
          description: "The context leans on this rather than merely benefiting from it."
        }
      },
      required: ["id", "capability"],
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      bindFrom(ctx);
      return text(await declareExtension(params ?? {}));
    }
  });

  // --- commands -------------------------------------------------------------

  async function contextNameCompletions(prefix) {
    try {
      const state = await loadState();
      return state.contexts
        .filter((context) => context.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((context) => ({
          value: context.name,
          label: context.name,
          description: "Context"
        }));
    } catch {
      return null;
    }
  }

  pi.registerCommand("neatcontext-status", {
    description: "Show what this session is grounded in",
    handler: async (_args, ctx) => {
      bindFrom(ctx);
      report(pi, await commandStatus());
    }
  });

  pi.registerCommand("neatcontext-list", {
    description: "List the contexts you can connect",
    handler: async (_args, ctx) => {
      bindFrom(ctx);
      report(pi, await commandList());
    }
  });

  // With no argument this is a picker rather than a printed list the model has
  // to interpret — the one place pi's in-process UI beats a slash command that
  // can only return text.
  pi.registerCommand("neatcontext-use", {
    description: "Connect a context to this session",
    getArgumentCompletions: contextNameCompletions,
    handler: async (args, ctx) => {
      bindFrom(ctx);
      let query = args.trim();
      if (query.length === 0 && ctx.hasUI) {
        const state = await loadState();
        if (state.contexts.length === 0) {
          report(pi, `No contexts to connect.\n\n${await commandList()}`);
          return;
        }
        const chosen = await ctx.ui.select(
          "Connect a NeatContext context",
          state.contexts.map((context) => context.name)
        );
        if (chosen === undefined) {
          return;
        }
        query = chosen;
      }
      report(pi, await commandUse(query));
    }
  });

  pi.registerCommand("neatcontext-extensions", {
    description: "What this context expects to reach, and whether this machine provides it",
    getArgumentCompletions: (prefix) =>
      ["status", "test", "remove"]
        .filter((action) => action.startsWith(prefix))
        .map((action) => ({ value: action, label: action })),
    handler: async (args, ctx) => {
      bindFrom(ctx);
      report(pi, await commandExtensions(args));
    }
  });

  pi.registerCommand("neatcontext-disconnect", {
    description: "Disconnect this session's context",
    handler: async (_args, ctx) => {
      bindFrom(ctx);
      report(pi, await commandDisconnect());
    }
  });

  pi.registerCommand("neatcontext-mode", {
    description: "How this session may route itself between contexts",
    getArgumentCompletions: (prefix) =>
      ["auto", "ask", "manual"]
        .filter((mode) => mode.startsWith(prefix))
        .map((mode) => ({ value: mode, label: mode })),
    handler: async (args, ctx) => {
      bindFrom(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const wanted = parts.find((part) => part !== "--global") ?? "";
      report(pi, await commandMode(wanted, { global: parts.includes("--global") }));
    }
  });

  pi.registerCommand("neatcontext-import", {
    description: "Import a shared conversation context bundle",
    handler: async (args, ctx) => {
      bindFrom(ctx);
      let from = args.trim();
      if (from.length === 0 && ctx.hasUI) {
        from = (await ctx.ui.input("Bundle folder to import", "path to the shared folder")) ?? "";
      }
      report(pi, await importContext({ from }));
    }
  });

  pi.registerCommand("neatcontext-export", {
    description: "Export a saved context as a shareable bundle",
    getArgumentCompletions: contextNameCompletions,
    handler: async (args, ctx) => {
      bindFrom(ctx);
      const options = parseExportArguments(args.trim());
      if (options.destination.length === 0 && ctx.hasUI) {
        options.destination =
          (await ctx.ui.input("Export bundle into", "destination folder")) ?? "";
      }
      report(pi, await exportContext(options));
    }
  });

  pi.registerCommand("neatcontext-delete", {
    description: "Delete a context",
    getArgumentCompletions: contextNameCompletions,
    handler: async (args, ctx) => {
      bindFrom(ctx);
      const plan = await deleteContext(args.trim());
      if (plan.done || !plan.target) {
        report(pi, plan.text);
        return;
      }
      const agreed = ctx.hasUI
        ? await ctx.ui.confirm(`Delete "${plan.target.name}"?`, plan.text)
        : false;
      if (!agreed) {
        report(pi, `${plan.text}\n\nNothing was deleted.`);
        return;
      }
      report(pi, (await deleteContext(args.trim(), { confirm: true })).text);
    }
  });

  // The two commands that need a model. Every command above is decided by code,
  // but a domain profile and a conversation summary can only be written by the
  // session that watched the work happen — so these hand the job to it, naming
  // the skill that says how, and it calls the tool once it has something to
  // write. This is what the other hosts get from a slash command that is itself
  // a prompt; pi command handlers are code, so the prompt is sent explicitly.
  pi.registerCommand("neatcontext-create", {
    description: "Create a context from a local knowledge folder",
    handler: async (args, ctx) => {
      bindFrom(ctx);
      pi.sendUserMessage(
        "Create a NeatContext context. Follow the `neatcontext-create` skill: gather " +
          "the name and the knowledge folder from me, read enough of that folder to draft " +
          "the domain profile and a one-line routing description, show me both, and call " +
          "the `neatcontext_create` tool once I agree.\n\n" +
          `What I said: ${args.trim() || "(nothing yet — ask me)"}`
      );
    }
  });

  pi.registerCommand("neatcontext-save", {
    description: "Save this conversation's durable work as a context",
    handler: async (args, ctx) => {
      bindFrom(ctx);
      pi.sendUserMessage(
        "Save the durable work from this conversation. Follow the `neatcontext-save` skill: " +
          "call `neatcontext_save` with only the name first to learn whether this creates or " +
          "updates, draft from what is visible in this conversation, and never invent work " +
          "that did not happen.\n\n" +
          `Name I gave, if any: ${args.trim() || "(none — derive one)"}`
      );
    }
  });

}
