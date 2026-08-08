// Command-line entry the slash commands call. Prints human-readable text that
// the slash command relays to the user. Subcommands:
//
//   status                     show the connected context
//   list                       list the contexts on this machine
//   use [query]                connect by number, exact name, or unique substring
//   disconnect                 disconnect the context from this session
//   create --name --knowledge  create a context (--profile-from <file>)
//   save-target [name]          decide whether save creates or updates
//   save --from <capture.json>  create or update from this conversation
//   import --from <bundle>      import a portable conversation context
//   export --to <folder>        copy a saved context's bundle out for sharing
//   delete <query> [--yes]     delete a context
//   mode [auto|ask|manual]     how the session may route itself between contexts
//   describe <query> --use-when   record what a context should be routed for
//   alias <query> --called        record what the user calls a context
//   extensions [add|remove|test]  what the connected context expects to reach,
//                                 and whether this machine provides it
//
// Exit code is always 0: the output is meant to be read, not branched on.

import { readFile, rm } from "node:fs/promises";
import "./session.mjs";
import { clearSelection, readSelection } from "../core/local-state.mjs";
import {
  createCapturedContext,
  createContext,
  deleteContext,
  exportContext,
  fingerprintContext,
  importCapturedContext,
  listContexts,
  ContextError,
  listKnowledgeFiles,
  previewCapturedContextUpdate,
  readProfileText,
  updateCapturedContext
} from "../core/context-store.mjs";
import {
  addAlias,
  isCardStale,
  MODES,
  putCard,
  readRouting,
  resolveMode,
  sessionId,
  setMode
} from "../core/routing.mjs";
import {
  addExtensionToContext,
  removeExtensionFromContext,
  renderExtensionsStatus,
  testExtension
} from "../core/extension-commands.mjs";
import { applySelection, disconnectSelection, resolveContext } from "../core/selection.mjs";

const CONTEXT_NOTE =
  "A context holds one domain profile, one primary knowledge folder, and optional " +
  "saved conversation notes.";

function print(line = "") {
  process.stdout.write(`${line}\n`);
}

// `--name value`, `--name=value`, and bare `--flag` booleans.
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, query: rest.join(" ").trim() };
}

function formatSection(title, contexts, connectedId, emptyNote) {
  if (contexts.length === 0) {
    return `${title}\n  ${emptyNote}`;
  }
  const width = Math.max(...contexts.map((context) => context.name.length), 0);
  const rows = contexts.map((context, index) => {
    const marker = context.id === connectedId ? "  (connected)" : "";
    return `  ${index + 1}. ${context.name.padEnd(width)}${marker}`.trimEnd();
  });
  return [title, ...rows].join("\n");
}

function formatList(state) {
  return formatSection(
    "Contexts:",
    state.contexts,
    state.connected?.id ?? null,
    "(none — save this conversation with `/neatcontext:save`, or create one from a docs folder with `/neatcontext:create`)"
  );
}

// Everything the commands need about the world: the contexts, and which one
// this session has selected.
async function loadState() {
  const selection = await readSelection();
  const contexts = await listContexts();

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

async function commandStatus(state) {
  const { connected, selection } = state;
  const routing = await readRouting();
  const mode = resolveMode(routing, sessionId());
  // Reported alongside the connection because the two together are the whole
  // answer to "what is this session going to do": what it is grounded in, and
  // whether it may re-ground itself.
  const reportMode = () => {
    const staleCard = connected?.stale === true;
    print(`Context routing: ${mode} (change with \`/neatcontext:mode\`)`);
    if (staleCard) {
      print(
        "  This context's routing description was derived from an older version of its " +
          "profile. Ask me to refresh it."
      );
    }
  };

  if (connected) {
    if (!connected.record) {
      print(
        `The context "${connected.name}" is connected but is no longer on disk. ` +
          "Use `/neatcontext:list` to pick another, or `/neatcontext:create` to make a new one."
      );
      return;
    }
    print(`Connected context: ${connected.name}`);
    print(`  Domain profile:   ${connected.record.profilePath}`);
    const folder = connected.record.knowledgeFolder;
    const { files } = await listKnowledgeFiles(folder);
    print(`  Knowledge folder: ${folder}${files.length > 0 ? ` (${files.length} files)` : ""}`);
    if (files.length === 0) {
      print(
        "  The knowledge folder is empty or missing — put TSGs, runbooks, or docs in it, " +
          "or check the path is still valid."
      );
    }
    if (!connected.record.knowledgeManaged && connected.record.conversationKnowledgeFolder) {
      const generated = await listKnowledgeFiles(connected.record.conversationKnowledgeFolder);
      if (generated.files.length > 0) {
        print(
          `  Conversation knowledge: ${connected.record.conversationKnowledgeFolder} ` +
            `(${generated.files.length} files)`
        );
      }
    }
    // Named but not started here: finding out whether an extension is actually
    // reachable means launching it, which `status` should not do on its own.
    if (connected.record.extensions.length > 0) {
      print(
        `  Extensions:       ${connected.record.extensions.map((entry) => entry.id).join(", ")} ` +
          "(run \`/neatcontext:extensions\` to see whether this machine provides them)"
      );
    }
    reportMode();
    return;
  }

  if (selection?.available === false) {
    print(
      `The previously selected context "${selection.contextName}" is not available to this ` +
        "plugin. Its stale selection has been cleared; use `/neatcontext:use` to pick a local Context."
    );
    reportMode();
    return;
  }

  // With an empty store `/neatcontext:use` has nothing to offer, so pointing
  // at it is a dead end for anyone who has just installed the plugin.
  print(
    state.contexts.length === 0
      ? "No context is connected, and there are none yet. Save this conversation as your first " +
        "one with `/neatcontext:save`, or build one from a folder of docs with " +
        "`/neatcontext:create`."
      : "No context is connected yet. Use `/neatcontext:use` to pick one."
  );
  reportMode();
}

function commandList(state) {
  print(formatList(state));
}

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

async function printUpdateTarget(target) {
  const routing = await readRouting();
  const useWhen = routing.cards[target.id]?.useWhen || target.routingDescription;
  print("Save action: update");
  print(`Context name: ${target.name}`);
  print(`Context id: ${target.id}`);
  print(`Base hash: ${await fingerprintContext(target)}`);
  print(`Profile path: ${target.profilePath}`);
  print(`Routing description: ${useWhen || "(none — derive one from the profile)"}`);
  print(`Knowledge folder: ${target.knowledgeFolder}`);
  if (target.knowledgeManaged) {
    print(`Conversation knowledge folder: ${target.knowledgeFolder}`);
    print("Knowledge ownership: managed by this context");
  } else {
    print(`Conversation knowledge folder: ${target.conversationKnowledgeFolder}`);
    print(
      "Knowledge ownership: linked folder is read-only; conversation updates are bundle-local"
    );
  }
}

// Save deliberately resolves names more strictly than `/use`: an exact,
// case-insensitive name updates, while a genuinely new name creates. Partial
// matching would turn "save as" into a surprising mutation.
async function commandSaveTarget(state, query) {
  if (query.length === 0) {
    if (state.connected?.record) {
      await printUpdateTarget(state.connected.record);
      return;
    }
    if (state.selection) {
      print("Save action: unavailable");
      print(
        `The connected context "${state.selection.contextName}" no longer exists on disk.`
      );
      print("Connect another context or provide a new context name.");
      return;
    }
    print("Save action: create");
    print("Context name: derive a short, specific name from the conversation");
    return;
  }

  const candidates = [...state.contexts];
  if (
    state.selection &&
    !candidates.some((context) => context.id === state.selection.contextId)
  ) {
    candidates.push({
      id: state.selection.contextId,
      name: state.selection.contextName,
      missing: true
    });
  }

  const exact = candidates.filter(
    (context) => saveNameKey(context.name) === saveNameKey(query)
  );
  if (exact.length > 1) {
    print("Save action: choose");
    print(`More than one context is named "${query}".`);
    for (const context of exact) {
      print(`  ${context.name}`);
    }
    print("Choose a distinct new name or resolve the duplicate before saving.");
    return;
  }
  if (exact.length === 1) {
    const target = exact[0];
    if (target.missing) {
      print("Save action: unavailable");
      print(`The context "${target.name}" no longer exists on disk.`);
      print("Choose a new context name or connect another context.");
      return;
    }
    await printUpdateTarget(target);
    return;
  }

  const similar = similarSaveTargets(candidates, query);
  if (similar.length > 0) {
    print("Save action: choose");
    print(`No context is named exactly "${query}", but these names are similar:`);
    for (const context of similar) {
      print(`  ${context.name}`);
    }
    print(`Confirm whether to create "${query}", or use an exact existing name to update it.`);
    return;
  }

  print("Save action: create");
  print(`Context name: ${query}`);
}

async function commandUse(state, query) {
  const { contexts } = state;
  if (contexts.length === 0) {
    print("No contexts to connect.");
    print("");
    print(formatList(state));
    return;
  }
  if (query.length === 0) {
    print("Which context should I connect?");
    print("");
    print(formatList(state));
    return;
  }

  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    print("");
    print(formatList(state));
    return;
  }

  const target = resolution.context;
  const result = await applySelection(target);
  print(
    `Connected the "${result.name}" context. Your next messages in this session ` +
      "will be grounded in its domain profile and knowledge folder."
  );
  await nudgeForDescription(target);
}

async function commandDisconnect(state) {
  const connected = state.connected;
  const remembered = state.selection;
  if (!connected && !remembered) {
    print("No context is connected to this session.");
    return;
  }

  await disconnectSelection();

  const name = connected?.name ?? remembered.contextName;
  print(`Disconnected the "${name}" context from this session.`);
}

// A context with no routing description can only be routed to by name.
// Connecting is the moment that changes: the profile is readable now, and the
// session that ran this command has a model to summarize it with. So the fix
// is to say so, here, and let the session do it.
async function nudgeForDescription(target) {
  const routing = await readRouting();
  if ((routing.cards[target.id]?.useWhen || target.routingDescription || "").length > 0) {
    return;
  }
  print("");
  print(
    "This context has no routing description yet, so it can only be routed to by name. " +
      "Derive one from what get_context returns, then record it with:"
  );
  print(`  neatcontext-cli.mjs describe "${target.name}" --use-when "<one line of scope>"`);
}

// Stores a routing description for a context that already exists. The line
// itself is written by the session's model — this only records it, against the
// text it was derived from so drift can be spotted later.
async function commandDescribe(state, query, flags) {
  const resolution = resolveContext(state.contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    return;
  }
  const useWhen = typeof flags["use-when"] === "string" ? flags["use-when"] : "";
  if (useWhen.trim().length === 0) {
    print("Pass the routing description with --use-when.");
    return;
  }
  const source = (await readProfileText(resolution.context)) ?? undefined;
  const card = await putCard(resolution.context.id, { useWhen, source });
  print(`"${resolution.context.name}" now routes for: ${card.useWhen}`);
}

// Naming a context by hand is also the clearest correction signal there is: the
// user is overriding whatever the session would have picked. `--called` records
// the words they used for it, so the next session routes them correctly without
// being told twice.
async function commandAlias(state, query, flags) {
  const resolution = resolveContext(state.contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    return;
  }
  const alias = typeof flags.called === "string" ? flags.called : "";
  const recorded = await addAlias(resolution.context.id, alias);
  if (!recorded) {
    print("Pass the words to remember with --called.");
    return;
  }
  print(`Noted — "${recorded}" now routes to "${resolution.context.name}".`);
}

async function commandMode(query, flags) {
  const routing = await readRouting();
  const id = sessionId();
  if (query.length === 0) {
    const active = resolveMode(routing, id);
    const scope = MODES.includes(routing.sessions[id]?.mode) ? "this session" : "the default";
    print(`Context routing is ${active} (${scope}).`);
    print("");
    print("  auto    switch context on a clear match, and say so; ask when it is a close call (default)");
    print("  ask     always ask before switching");
    print("  manual  never route — /neatcontext:use only");
    print("");
    print(`Change it with \`/neatcontext:mode <${MODES.join("|")}>\`.`);
    return;
  }

  const wanted = query.trim().toLowerCase();
  if (!MODES.includes(wanted)) {
    print(`"${query}" is not a mode. Use one of: ${MODES.join(", ")}.`);
    return;
  }
  const isGlobal = flags.global === true || flags.global === "true";
  const result = await setMode(wanted, { global: isGlobal, id });
  print(
    result.scope === "global"
      ? `Context routing is now ${wanted} everywhere (the default for new sessions).`
      : `Context routing is now ${wanted} for this session.`
  );
  if (wanted === "auto") {
    print(
      "In auto mode this session switches context on its own, and tells you when it does. " +
        "Other sessions keep theirs."
    );
  }
}

async function commandCreate(flags) {
  const name = typeof flags.name === "string" ? flags.name : "";
  const knowledge = typeof flags.knowledge === "string" ? flags.knowledge : "";
  let profile = typeof flags.profile === "string" ? flags.profile : "";

  // Prose arrives by file, not argv: multi-line profiles do not survive shell
  // quoting on either platform.
  if (typeof flags["profile-from"] === "string") {
    try {
      profile = await readFile(flags["profile-from"], "utf8");
    } catch {
      print(`Could not read the profile file at ${flags["profile-from"]}.`);
      return;
    }
  }

  try {
    const { record, profileText, knowledgeFileCount } = await createContext({
      name,
      knowledgeFolder: knowledge,
      profile
    });
    // The routing line is derived from the profile by the model that ran this
    // command, and stored against the profile it was derived from: edit the
    // profile later and the hash stops matching, which is how a session finds
    // out the line now describes something the context no longer is.
    //
    // `profileText`, not `profile` — the stored profile is normalized, and
    // hashing the input would make every context stale from the moment it was
    // created.
    const useWhen = typeof flags["use-when"] === "string" ? flags["use-when"] : "";
    await putCard(record.id, { useWhen, source: profileText });
    print(`Created the "${record.name}" context.`);
    print(`  Domain profile:   ${record.profilePath}`);
    if (useWhen.trim().length > 0) {
      print(`  Routes here for:  ${useWhen.trim()}`);
    }
    print(
      `  Knowledge folder: ${record.knowledgeFolder}` +
        (knowledgeFileCount > 0 ? ` (${knowledgeFileCount} files)` : " (empty for now)")
    );
    print(`  Connect it with:  /neatcontext:use ${record.name}`);
    if (knowledgeFileCount === 0) {
      print("The folder has no files yet — put the TSGs, runbooks, or docs in it before asking questions.");
    }
    print(CONTEXT_NOTE);
  } catch (error) {
    if (error instanceof ContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

// The model in the active Copilot session writes the capture spec: it is the
// only process that can see the conversation, and reusing it avoids a second
// model call or a transcript reader. This command validates that output, turns
// it into files, and creates or updates the selected context.
function printChangedFiles(label, files) {
  if (files.length === 0) {
    return;
  }
  print(`  ${label}: ${files.join(", ")}`);
}

function printUpdatePreview(preview) {
  const { record, changes } = preview;
  print(`Update the "${record.name}" context?`);
  print(`  Domain profile: ${preview.profileChanged ? "changed" : "unchanged"}`);
  print(`  Routing description: ${preview.routingChanged ? "changed" : "unchanged"}`);
  print(
    `  Knowledge files: ${changes.added.length} added, ` +
      `${changes.updated.length} updated, ${changes.removed.length} removed`
  );
  printChangedFiles("Add", changes.added);
  printChangedFiles("Update", changes.updated);
  printChangedFiles("Remove", changes.removed);
  if (!record.knowledgeManaged) {
    print(`  Linked knowledge folder will not be modified: ${record.knowledgeFolder}`);
  }
  print("Re-run this save with --yes to confirm.");
}

async function commandSave(flags) {
  const source = typeof flags.from === "string" ? flags.from : "";
  if (source.trim().length === 0) {
    print("Pass the generated conversation capture with --from <capture.json>.");
    return;
  }

  let capture;
  try {
    capture = JSON.parse(await readFile(source, "utf8"));
  } catch {
    print(`Could not read a valid conversation capture JSON file at ${source}.`);
    return;
  }
  if (capture?.schema !== 1) {
    print("Unsupported conversation capture schema. Expected schema 1.");
    return;
  }

  try {
    if (typeof capture.targetId === "string" && capture.targetId.length > 0) {
      const preview = await previewCapturedContextUpdate(capture);
      if (!preview.changed) {
        print(`The capture does not change the "${preview.record.name}" context.`);
        return;
      }
      if (flags.yes !== true && flags.yes !== "true") {
        printUpdatePreview(preview);
        return;
      }
      const result = await updateCapturedContext({
        ...capture,
        updatedFrom: "copilot-conversation"
      });
      await putCard(result.record.id, {
        useWhen: result.routingDescription,
        source: result.profileText
      }).catch(() => undefined);
      if (flags.consume === true || flags.consume === "true") {
        await rm(source, { force: true });
      }
      // The save nudge's "nothing new since the last save" suppressor starts
      print(`Updated context: ${result.record.name}`);
      print(`Context folder: ${result.record.directory}`);
      print(`Profile path: ${result.record.profilePath}`);
      print(`Knowledge folder: ${result.record.knowledgeFolder}`);
      if (!result.record.knowledgeManaged) {
        print(`Conversation knowledge folder: ${result.record.conversationKnowledgeFolder}`);
      }
      print(`Use command: /neatcontext:use ${result.record.name}`);
      return;
    }

    const result = await createCapturedContext({
      ...capture,
      capturedFrom: "copilot-conversation"
    });
    await putCard(result.record.id, {
      useWhen: result.routingDescription,
      source: result.profileText
    }).catch(() => undefined);
    if (flags.consume === true || flags.consume === "true") {
      await rm(source, { force: true });
    }
    print(`Context folder: ${result.record.directory}`);
    print(`Profile path: ${result.record.profilePath}`);
    print(`Knowledge folder: ${result.record.knowledgeFolder}`);
    print(`Use command: /neatcontext:use ${result.record.name}`);
  } catch (error) {
    if (error instanceof ContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

async function commandImport(flags) {
  const source = typeof flags.from === "string" ? flags.from : "";
  const name = typeof flags.name === "string" ? flags.name : "";
  try {
    const result = await importCapturedContext({ bundleFolder: source, name });
    await putCard(result.record.id, {
      useWhen: result.routingDescription,
      source: result.profileText
    }).catch(() => undefined);
    print(`Imported the "${result.record.name}" conversation context.`);
    print(`  Domain profile:   ${result.record.profilePath}`);
    print(
      `  Knowledge folder: ${result.record.knowledgeFolder} ` +
        `(${result.knowledgeFileCount} files)`
    );
    print(`  Local bundle:     ${result.record.directory}`);
    print(`  Connect it with:  /neatcontext:use ${result.record.name}`);
    print(`The shared source folder (${source}) was left untouched.`);
  } catch (error) {
    if (error instanceof ContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

// The routing description is read from the card rather than the manifest:
// `describe` records a newer line there, and the copy the teammate imports
// should route the way this one does.
async function commandExport(state, query, flags) {
  const destination = typeof flags.to === "string" ? flags.to : "";
  if (destination.trim().length === 0) {
    print("Pass the destination folder with --to <folder>.");
    return;
  }

  let target = null;
  if (query.length === 0) {
    if (state.connected?.record) {
      target = state.connected.record;
    } else {
      print("Which context should I export?");
      print("");
      print(formatList(state));
      return;
    }
  } else {
    const resolution = resolveContext(state.contexts, query);
    if (resolution.error) {
      print(`No single context matched "${query}".`);
      print("");
      print(formatList(state));
      return;
    }
    target = resolution.context;
  }

  const routing = await readRouting();
  try {
    const result = await exportContext({
      record: target,
      destination,
      force: flags.force === true || flags.force === "true",
      routingDescription: routing.cards[target.id]?.useWhen
    });
    print(
      result.replaced
        ? `Exported the "${result.record.name}" context, replacing what was there.`
        : `Exported the "${result.record.name}" context.`
    );
    print(`  Bundle folder:    ${result.destination}`);
    print(`  Knowledge files:  ${result.knowledgeFileCount}`);
    print(`  Import it with:   /neatcontext:import ${result.destination}`);
    print("This context was not changed — the export is a copy.");
  } catch (error) {
    if (error instanceof ContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

async function commandDelete(state, query, flags) {
  if (query.length === 0) {
    print("Which context should I delete?");
    print("");
    print(formatList(state));
    return;
  }

  const resolution = resolveContext(state.contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    print("");
    print(formatList(state));
    return;
  }

  const target = resolution.context;
  if (flags.yes !== true && flags.yes !== "true") {
    print(`This will delete the "${target.name}" context:`);
    print(`  ${target.directory}`);
    print(
      target.knowledgeManaged
        ? `Its generated knowledge folder (${target.knowledgeFolder}) is inside the bundle and will be deleted.`
        : `Its knowledge folder (${target.knowledgeFolder}) will NOT be touched.`
    );
    print("Re-run with --yes to confirm.");
    return;
  }

  const deleted = await deleteContext(target.id);
  const removed = deleted ?? target;
  print(`Deleted the "${removed.name}" context.`);
  print(
    removed.knowledgeManaged
      ? `Its generated knowledge folder (${removed.knowledgeFolder}) was deleted with it.`
      : `Its knowledge folder (${removed.knowledgeFolder}) was left untouched.`
  );
  if (state.connected?.id === removed.id) {
    await clearSelection();
    print("It was the connected context, so this session is no longer grounded in one.");
  }
}

// `extensions`, `extensions add <id>`, `extensions remove <id>`,
// `extensions test <id>`. Everything here acts on the connected context,
// because an extension belongs to a context rather than to the machine.
async function commandExtensions(state, query, flags) {
  const [action = "", ...rest] = query.split(/\s+/).filter(Boolean);
  const id = rest.join(" ").trim();
  const record = state.connected?.record ?? null;

  if (action.length === 0 || action === "status") {
    print(await renderExtensionsStatus(record));
    return;
  }
  if (!record) {
    print("No context is connected to this session, so there is nothing to change.");
    return;
  }

  if (action === "add") {
    const capability = typeof flags.capability === "string" ? flags.capability : "";
    if (id.length === 0 || capability.trim().length === 0) {
      print(
        'Use: extensions add <id> --capability "what it lets this context do" ' +
          "[--tools a,b] [--important]"
      );
      return;
    }
    const added = await addExtensionToContext(record, id, {
      capability,
      tools: typeof flags.tools === "string" ? flags.tools : undefined,
      important: flags.important === true || flags.important === "true"
    });
    print(added.text);
    return;
  }
  if (action === "remove") {
    if (id.length === 0) {
      print("Use: extensions remove <id>");
      return;
    }
    print((await removeExtensionFromContext(record, id)).text);
    return;
  }
  if (action === "test") {
    if (id.length === 0) {
      print("Use: extensions test <id>");
      return;
    }
    print(await testExtension(record, id));
    return;
  }

  print(`Unknown extensions action "${action}". Use: status | add | remove | test.`);
}

async function run() {
  const [command = "status", ...rest] = process.argv.slice(2);
  const { flags, query } = parseArgs(rest);

  if (command === "create") {
    await commandCreate(flags);
    return;
  }
  if (command === "save") {
    await commandSave(flags);
    return;
  }
  if (command === "import") {
    await commandImport(flags);
    return;
  }
  // Reads no context list: still answers before anything has been created.
  if (command === "mode") {
    await commandMode(query, flags);
    return;
  }

  const state = await loadState();

  if (command === "status") {
    await commandStatus(state);
    return;
  }
  if (command === "list") {
    commandList(state);
    return;
  }
  if (command === "save-target") {
    await commandSaveTarget(state, query);
    return;
  }
  if (command === "use") {
    await commandUse(state, query);
    return;
  }
  if (command === "disconnect") {
    await commandDisconnect(state);
    return;
  }
  if (command === "export") {
    await commandExport(state, query, flags);
    return;
  }
  if (command === "delete") {
    await commandDelete(state, query, flags);
    return;
  }
  if (command === "alias") {
    await commandAlias(state, query, flags);
    return;
  }
  if (command === "describe") {
    await commandDescribe(state, query, flags);
    return;
  }
  if (command === "extensions") {
    await commandExtensions(state, query, flags);
    return;
  }
  print(
    `Unknown command "${command}". ` +
      "Use: status | list | use | disconnect | create | save | import | export | delete | mode | alias | describe | extensions."
  );
}

run()
  .catch((error) => {
    print(`NeatContext plugin error: ${error?.message ?? error}`);
  })
  .finally(() => process.exit(0));
