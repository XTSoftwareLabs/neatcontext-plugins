// Local Context storage shared by every NeatContext host plugin.
//
// A Context lives entirely on disk: one domain profile, one primary knowledge
// folder, and optional saved conversation notes. It needs no other process.
//
//   <home>/contexts/<slug>-<suffix>/context.json   versioned metadata
//   <home>/contexts/<slug>-<suffix>/profile.md     hand-editable domain profile
//   <home>/contexts/<slug>-<suffix>/knowledge/     capture or update supplement
//
// The create workflow references a user-owned knowledge folder and never
// copies or deletes it. Saving more conversation work into one of those
// contexts writes a supplement inside the context directory. A context first
// made by save owns its complete generated knowledge folder.

import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeExtensionDeclarations,
  readExtensionDeclarations,
  serializeExtensionDeclarations
} from "./extensions.mjs";
import { neatContextHome } from "./storage-home.mjs";

export const CONTEXT_ID_PREFIX = "context:";
export const CONTEXT_SCHEMA = 2;
const LEGACY_SCHEMA = 1;
const MAX_NAME_LENGTH = 80;
const MAX_LISTED_FILES = 200;
const MAX_LISTING_DEPTH = 3;
const MAX_CAPTURE_FILES = 24;
const MAX_CAPTURE_FILE_BYTES = 256 * 1024;
const MAX_CAPTURE_TOTAL_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_ROUTING_DESCRIPTION = 240;
// Matching material rather than reading material: none of this is ever shown to
// a session, so the limits are about keeping a bundle sane, not a prompt short.
const MAX_ROUTING_QUESTIONS = 20;
const MAX_ROUTING_ENTITIES = 40;
const MAX_ROUTING_TERM = 200;
const UPDATE_LOCK_STALE_MS = 60_000;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__"]);

export class ContextError extends Error {}

function isConversationCapture(origin) {
  return (
    origin === "conversation" ||
    (typeof origin === "string" && origin.endsWith("-conversation"))
  );
}

export function contextHome() {
  return path.join(neatContextHome(), "contexts");
}

export function legacyContextHome() {
  return path.join(neatContextHome(), "lite");
}

function slugify(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "context";
}

function recordFor(directory, parsed) {
  const legacy = parsed?.schema === LEGACY_SCHEMA && parsed?.kind === "lite";
  // `kind` is a schema 1 concept and means nothing at CONTEXT_SCHEMA, so a
  // vestigial one is ignored rather than treated as an unreadable manifest.
  // Being strict here stranded every context an older build upgraded without
  // dropping it: the bundle was intact and the plugin could not see it.
  const current = parsed?.schema === CONTEXT_SCHEMA;
  if ((!legacy && !current) || typeof parsed.id !== "string" || typeof parsed.name !== "string") {
    return null;
  }
  const storedKnowledgeFolder =
    typeof parsed.knowledgeFolder === "string" ? parsed.knowledgeFolder : "";
  const knowledgeFolder =
    storedKnowledgeFolder.length === 0
      ? ""
      : path.isAbsolute(storedKnowledgeFolder)
        ? storedKnowledgeFolder
        : path.resolve(directory, storedKnowledgeFolder);
  const knowledgeManaged =
    parsed.knowledgeManaged === true &&
    storedKnowledgeFolder === "knowledge";
  return {
    id: parsed.id,
    name: parsed.name,
    schema: legacy ? LEGACY_SCHEMA : CONTEXT_SCHEMA,
    legacy,
    directory,
    knowledgeFolder,
    knowledgeManaged,
    // `/create` contexts keep their user-owned folder untouched. Conversation
    // updates for those contexts live in this bundle-local supplement instead,
    // so every Context can be updated without claiming ownership of linked
    // files. Older manifests need no migration: the path becomes real on the
    // first update.
    conversationKnowledgeFolder: knowledgeManaged ? null : path.join(directory, "knowledge"),
    routingDescription:
      typeof parsed.routingDescription === "string" ? parsed.routingDescription : "",
    // Index-only matching material. It travels with the bundle so a teammate's
    // copy is findable by the same words as yours, which is the whole reason it
    // lives here rather than in this machine's routing cache.
    routingQuestions: normalizeRoutingList(parsed.routingQuestions, MAX_ROUTING_QUESTIONS),
    routingEntities: normalizeRoutingList(parsed.routingEntities, MAX_ROUTING_ENTITIES),
    // What this context expects to be able to reach. Read leniently: a
    // declaration this plugin cannot make sense of is dropped rather than
    // allowed to hide the profile and knowledge behind it.
    extensions: readExtensionDeclarations(parsed.extensions),
    capturedFrom: typeof parsed.capturedFrom === "string" ? parsed.capturedFrom : null,
    capturedFromConversation: isConversationCapture(parsed.capturedFrom),
    profilePath: path.join(directory, "profile.md"),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    revision:
      Number.isInteger(parsed.revision) && parsed.revision > 0
        ? parsed.revision
        : 1
  };
}

async function readableContext(directory) {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
    return recordFor(directory, parsed);
  } catch {
    return null;
  }
}

// A context bundle written by an earlier release stays exactly where that
// release put it.
//
// Relocating it is the one thing this store must not do while a machine can
// have several host plugins installed at different versions. They all share
// ~/.neatcontext, and a release that predates the unified Context model reads
// only the legacy root — so moving a bundle out of it makes every context
// vanish from every host that has not been updated yet. The bundle is intact
// and invisible, with nothing to point the user at.
//
// Nothing is lost by leaving them: both roots are scanned below, and both
// manifest shapes are readable. A future release can relocate them once no
// supported version reads the legacy root.

async function scanContextRoot(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const record = await readableContext(path.join(root, entry.name));
    if (record) records.push(record);
  }
  return records;
}

// Every readable Context, sorted by name, from both roots. One malformed
// directory never hides the others. The neutral root wins if the same
// identifier somehow appears in both locations.
export async function listContexts() {
  const records = [
    ...(await scanContextRoot(contextHome())),
    ...(await scanContextRoot(legacyContextHome()))
  ];
  const byId = new Map();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

export async function readContext(id) {
  const contexts = await listContexts();
  return contexts.find((context) => context.id === id) ?? null;
}

// The profile as written. A routing description is derived from this text and
// remembers its hash, so reading it back is how the plugin notices the user has
// since rewritten the profile and left the description describing the old one.
export async function readProfileText(record) {
  try {
    return await readFile(record.profilePath, "utf8");
  } catch {
    return null;
  }
}

async function directoryExists(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeName(name) {
  const cleanName = (name ?? "").trim();
  if (cleanName.length === 0) {
    throw new ContextError("A context name is required.");
  }
  if (cleanName.length > MAX_NAME_LENGTH) {
    throw new ContextError(`Keep the context name under ${MAX_NAME_LENGTH} characters.`);
  }
  if (/[\r\n]/.test(cleanName)) {
    throw new ContextError("A context name must be a single line.");
  }
  return cleanName;
}

function normalizeProfile(profile) {
  const cleanProfile = (profile ?? "").trim();
  if (cleanProfile.length === 0) {
    throw new ContextError("The domain profile is empty. Describe what the context is for.");
  }
  if (Buffer.byteLength(cleanProfile, "utf8") > MAX_PROFILE_BYTES) {
    throw new ContextError("Keep the domain profile under 128 KB.");
  }
  return `${cleanProfile}\n`;
}

async function ensureUniqueName(cleanName) {
  const existing = await listContexts();
  if (existing.some((context) => context.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new ContextError(
      `A context named "${cleanName}" already exists. Pick another name or delete that one first.`
    );
  }
}

function contextPaths(cleanName) {
  const suffix = randomBytes(6).toString("hex");
  return {
    suffix,
    directory: path.join(contextHome(), `${slugify(cleanName)}-${suffix}`),
    staging: path.join(contextHome(), `.staging-${suffix}`)
  };
}

// Creates the context from an already-answered wizard. Everything is validated
// before anything is written, and the context is assembled in a temp directory
// then renamed into place, so a failure never leaves a half-context behind.
export async function createContext({ name, knowledgeFolder, profile, extensions }) {
  const cleanName = normalizeName(name);
  const profileText = normalizeProfile(profile);
  const declarations = serializeExtensionDeclarations(extensions ?? []);

  const folder = path.resolve((knowledgeFolder ?? "").trim());
  if ((knowledgeFolder ?? "").trim().length === 0) {
    throw new ContextError("A knowledge folder is required.");
  }
  if (!(await directoryExists(folder))) {
    throw new ContextError(
      `No folder at ${folder}. Give me a path to an existing folder holding the TSGs, ` +
        "runbooks, or docs this context should use."
    );
  }

  await ensureUniqueName(cleanName);

  const { suffix, directory, staging } = contextPaths(cleanName);
  const record = {
    schema: CONTEXT_SCHEMA,
    id: `${CONTEXT_ID_PREFIX}${slugify(cleanName)}-${suffix}`,
    name: cleanName,
    profileFile: "profile.md",
    createdAt: new Date().toISOString(),
    revision: 1,
    knowledgeFolder: folder
  };
  if (declarations) record.extensions = declarations;
  record.updatedAt = record.createdAt;

  await mkdir(staging, { recursive: true });
  try {
    await writeFile(path.join(staging, "profile.md"), profileText, "utf8");
    await writeFile(
      path.join(staging, "context.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    record: recordFor(directory, record),
    profileText,
    knowledgeFileCount: (await listKnowledgeFiles(folder)).files.length
  };
}

// The questions a context should catch, and the names that appear in it.
//
// A description answers "what is this?", which is not how anyone searches. They
// search with the words of their problem, so these hold the other vocabulary:
// the phrasings a user would actually type, and the service names, ticket ids
// and error strings that appear in one context and nowhere else. Both are
// matched against and neither is ever displayed, which is what makes them cheap
// enough to keep in bulk.
//
// Optional, unlike the description. A bundle written before this existed, or by
// a host that does not generate them, is not broken — it just matches on less.
// Terms that cannot mean the same thing on anyone else's machine, or that name
// a person rather than a subject.
//
// A context is domain knowledge, and it is meant to be handed to a teammate
// intact. A matching list is the easiest place for that to quietly stop being
// true: an absolute path or a home directory looks like a useful rare term
// while it is being written and is worthless — or worse, revealing — the moment
// the bundle leaves the machine.
//
// This drops them from the matching lists only. If a local path really is part
// of what the context is about, the profile and the knowledge folder are where
// it belongs and are untouched by this; being unable to *search* for a context
// by someone's home directory costs nothing worth having.
const NOT_PORTABLE =
  /(^|\s)(~[\\/]|[a-z]:[\\/]|\\\\)|[\\/](home|users|root)[\\/]|\S+@\S+\.\S/i;

function normalizeRoutingList(value, limit) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const kept = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim().replace(/\s+/g, " ").slice(0, MAX_ROUTING_TERM);
    const key = clean.toLowerCase();
    if (clean.length === 0 || seen.has(key) || NOT_PORTABLE.test(clean)) continue;
    seen.add(key);
    kept.push(clean);
    if (kept.length === limit) break;
  }
  return kept;
}

function normalizeRoutingDescription(value) {
  const description = (value ?? "").trim().replace(/\s+/g, " ");
  if (description.length === 0) {
    throw new ContextError(
      "The routing description is empty. Say what future requests belong in this context."
    );
  }
  if (description.length > MAX_ROUTING_DESCRIPTION) {
    throw new ContextError(
      `Keep the routing description under ${MAX_ROUTING_DESCRIPTION} characters.`
    );
  }
  return description;
}

function normalizeCaptureKnowledge(knowledge) {
  if (!Array.isArray(knowledge) || knowledge.length === 0) {
    throw new ContextError(
      "The capture has no knowledge files. Include at least knowledge/session-summary.md."
    );
  }
  if (knowledge.length > MAX_CAPTURE_FILES) {
    throw new ContextError(`Keep a conversation capture to ${MAX_CAPTURE_FILES} files or fewer.`);
  }

  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of knowledge) {
    const portablePath =
      typeof entry?.path === "string" ? entry.path.trim().replace(/\\/g, "/") : "";
    const parts = portablePath.split("/");
    if (
      portablePath.length === 0 ||
      portablePath.length > 180 ||
      path.posix.isAbsolute(portablePath) ||
      parts.length > MAX_LISTING_DEPTH + 1 ||
      parts.some(
        (part) =>
          part.length === 0 ||
          part.length > 100 ||
          part === "." ||
          part === ".." ||
          /[<>:"|?*\u0000-\u001f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
    ) {
      throw new ContextError(
        `Invalid knowledge file path "${portablePath || "(empty)"}". Use a short relative path.`
      );
    }
    if (!portablePath.toLowerCase().endsWith(".md")) {
      throw new ContextError(
        `Knowledge file "${portablePath}" must be Markdown (a .md file).`
      );
    }
    const key = portablePath.toLowerCase();
    if (seen.has(key)) {
      throw new ContextError(`Knowledge file "${portablePath}" appears more than once.`);
    }
    if ([...seen].some((other) => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) {
      throw new ContextError(`Knowledge file "${portablePath}" conflicts with another path.`);
    }
    seen.add(key);

    const content = typeof entry?.content === "string" ? entry.content.trim() : "";
    if (content.length === 0) {
      throw new ContextError(`Knowledge file "${portablePath}" is empty.`);
    }
    const text = `${content}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CAPTURE_FILE_BYTES) {
      throw new ContextError(`Knowledge file "${portablePath}" is larger than 256 KB.`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_CAPTURE_TOTAL_BYTES) {
      throw new ContextError("Keep the generated knowledge bundle under 1 MB.");
    }
    files.push({ path: portablePath, text });
  }

  if (!seen.has("session-summary.md")) {
    throw new ContextError(
      "The capture must include session-summary.md so a future session has an entry point."
    );
  }
  return files;
}

// Saves work already present in the host conversation. Unlike `createContext`,
// this owns the knowledge it writes. Relative storage is the portability
// contract: copying this one directory to another machine keeps every pointer
// valid without exposing or repairing an absolute path from the creator.
export async function createCapturedContext({
  name,
  profile,
  routingDescription,
  routingQuestions,
  routingEntities,
  knowledge,
  extensions,
  capturedFrom = "conversation"
}) {
  const cleanName = normalizeName(name);
  const profileText = normalizeProfile(profile);
  const useWhen = normalizeRoutingDescription(routingDescription);
  const questions = normalizeRoutingList(routingQuestions, MAX_ROUTING_QUESTIONS);
  const entities = normalizeRoutingList(routingEntities, MAX_ROUTING_ENTITIES);
  const files = normalizeCaptureKnowledge(knowledge);
  const declarations = serializeExtensionDeclarations(extensions ?? []);
  await ensureUniqueName(cleanName);

  const { suffix, directory, staging } = contextPaths(cleanName);
  const record = {
    schema: CONTEXT_SCHEMA,
    id: `${CONTEXT_ID_PREFIX}${slugify(cleanName)}-${suffix}`,
    name: cleanName,
    profileFile: "profile.md",
    createdAt: new Date().toISOString(),
    revision: 1,
    knowledgeFolder: "knowledge",
    knowledgeManaged: true,
    capturedFrom: isConversationCapture(capturedFrom) ? capturedFrom : "conversation",
    routingDescription: useWhen
  };
  // Absent rather than empty when there is nothing: a manifest should not carry
  // a field that says only that a host did not fill it in.
  if (questions.length > 0) record.routingQuestions = questions;
  if (entities.length > 0) record.routingEntities = entities;
  if (declarations) record.extensions = declarations;
  record.updatedAt = record.createdAt;

  try {
    await mkdir(path.join(staging, "knowledge"), { recursive: true });
    await writeFile(path.join(staging, "profile.md"), profileText, "utf8");
    for (const file of files) {
      const target = path.join(staging, "knowledge", ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, "utf8");
    }
    await writeFile(
      path.join(staging, "context.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    record: recordFor(directory, record),
    profileText,
    routingDescription: useWhen,
    knowledgeFileCount: files.length
  };
}

function generatedKnowledgeFolder(record) {
  return record.knowledgeManaged
    ? record.knowledgeFolder
    : record.conversationKnowledgeFolder;
}

async function readGeneratedKnowledge(record) {
  const folder = generatedKnowledgeFolder(record);
  const { files, truncated } = await listKnowledgeFiles(folder, {
    limit: MAX_CAPTURE_FILES + 1
  });
  if (truncated || files.length > MAX_CAPTURE_FILES) {
    throw new ContextError(
      "This context has too many generated knowledge files to update safely."
    );
  }
  const entries = [];
  for (const file of files) {
    entries.push({
      path: file,
      content: await readFile(path.join(folder, ...file.split("/")), "utf8")
    });
  }
  return entries;
}

// The optimistic-concurrency token used between drafting an update and
// applying it. Linked `/create` knowledge is deliberately excluded: save never
// rewrites those user-owned files. Everything save can replace is included.
export async function fingerprintContext(record) {
  const profile = await readProfileText(record);
  const knowledge = await readGeneratedKnowledge(record);
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      id: record.id,
      name: record.name,
      knowledgeFolder: record.knowledgeFolder,
      knowledgeManaged: record.knowledgeManaged,
      routingDescription: record.routingDescription,
      extensions: record.extensions,
      capturedFrom: record.capturedFrom,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision
    })
  );
  hash.update("\0profile\0");
  hash.update(profile ?? "");
  for (const entry of knowledge) {
    hash.update("\0knowledge\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.content);
  }
  return hash.digest("hex");
}

function knowledgeChanges(before, after) {
  const oldFiles = new Map(before.map((entry) => [entry.path, entry.content]));
  const newFiles = new Map(after.map((entry) => [entry.path, entry.text]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const [file, content] of newFiles) {
    if (!oldFiles.has(file)) {
      added.push(file);
    } else if (oldFiles.get(file) !== content) {
      updated.push(file);
    }
  }
  for (const file of oldFiles.keys()) {
    if (!newFiles.has(file)) {
      removed.push(file);
    }
  }
  return { added, updated, removed };
}

function requireCurrentBase(record, actual, expected) {
  if (actual !== expected) {
    throw new ContextError(
      `The "${record.name}" context changed while this update was being prepared. ` +
        "Run `/neatcontext:save` again so the newer content is preserved."
    );
  }
}

async function prepareCapturedContextUpdate({
  targetId,
  baseHash,
  name,
  profile,
  routingDescription,
  routingQuestions,
  routingEntities,
  knowledge,
  extensions
}) {
  const record = await readContext(targetId);
  if (!record) {
    throw new ContextError("The context selected for this update no longer exists.");
  }
  const suppliedName = normalizeName(name);
  if (suppliedName.toLowerCase() !== record.name.toLowerCase()) {
    throw new ContextError(
      `The update was prepared for "${suppliedName}", but the target is "${record.name}".`
    );
  }
  if (typeof baseHash !== "string" || baseHash.length === 0) {
    throw new ContextError("The update has no base hash. Resolve the save target again.");
  }
  const currentHash = await fingerprintContext(record);
  requireCurrentBase(record, currentHash, baseHash);
  const profileText = normalizeProfile(profile);
  const useWhen = normalizeRoutingDescription(routingDescription);
  // Same rule as extensions below: a save that says nothing about the matching
  // material leaves what is there alone. A host that does not generate these
  // must not silently strip what another host wrote.
  const questions =
    routingQuestions === undefined
      ? record.routingQuestions
      : normalizeRoutingList(routingQuestions, MAX_ROUTING_QUESTIONS);
  const entities =
    routingEntities === undefined
      ? record.routingEntities
      : normalizeRoutingList(routingEntities, MAX_ROUTING_ENTITIES);
  const files = normalizeCaptureKnowledge(knowledge);
  // A save that says nothing about extensions leaves them exactly as they are.
  // Declarations are usually added deliberately, by hand or by `extensions add`,
  // and a conversation capture is not evidence that the user wants them gone.
  const declarations =
    extensions === undefined ? record.extensions : normalizeExtensionDeclarations(extensions);
  const currentKnowledge = await readGeneratedKnowledge(record);
  const changes = knowledgeChanges(currentKnowledge, files);
  const profileChanged = (await readProfileText(record)) !== profileText;
  const routingChanged =
    record.routingDescription !== useWhen ||
    JSON.stringify(record.routingQuestions) !== JSON.stringify(questions) ||
    JSON.stringify(record.routingEntities) !== JSON.stringify(entities);
  const extensionsChanged =
    JSON.stringify(record.extensions) !== JSON.stringify(declarations);
  return {
    record,
    profileText,
    useWhen,
    questions,
    entities,
    files,
    declarations,
    changes,
    profileChanged,
    routingChanged,
    extensionsChanged,
    changed:
      profileChanged ||
      routingChanged ||
      extensionsChanged ||
      changes.added.length > 0 ||
      changes.updated.length > 0 ||
      changes.removed.length > 0
  };
}

export async function previewCapturedContextUpdate(capture) {
  return prepareCapturedContextUpdate(capture);
}

async function acquireUpdateLock(record) {
  // Locks and staging live in the neutral root even when the context being
  // updated is still in the legacy one, so the root has to exist before either
  // is taken. Nothing else creates it on a machine whose contexts all predate
  // the unified model and are left where they are.
  await mkdir(contextHome(), { recursive: true });
  const lock = path.join(contextHome(), `.update-${slugify(record.id)}.lock`);
  try {
    await mkdir(lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (Date.now() - (await stat(lock)).mtimeMs <= UPDATE_LOCK_STALE_MS) {
      throw new ContextError(
        `The "${record.name}" context is already being updated. Try again in a moment.`
      );
    }
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  return async () => {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  };
}

// Kept separate so the rollback path is directly testable. The backup lives
// beside both directories, making every rename stay on one filesystem.
export async function replaceContextDirectory(directory, staging, backup) {
  await rename(directory, backup);
  try {
    await rename(staging, directory);
  } catch (error) {
    await rename(backup, directory);
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

// Replaces only plugin-owned state. For a saved context that is its complete
// knowledge folder; for a `/create` context it is a bundle-local conversation
// supplement. The linked folder is read-only throughout this operation.
export async function updateCapturedContext(capture) {
  const prepared = await prepareCapturedContextUpdate(capture);
  if (!prepared.changed) {
    throw new ContextError(
      `The capture does not change the "${prepared.record.name}" context.`
    );
  }

  const release = await acquireUpdateLock(prepared.record);
  const suffix = randomBytes(6).toString("hex");
  const staging = path.join(contextHome(), `.staging-update-${suffix}`);
  const backup = path.join(contextHome(), `.backup-update-${suffix}`);
  try {
    const currentHash = await fingerprintContext(prepared.record);
    requireCurrentBase(prepared.record, currentHash, capture.baseHash);

    await cp(prepared.record.directory, staging, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await rm(path.join(staging, "knowledge"), { recursive: true, force: true });
    await mkdir(path.join(staging, "knowledge"), { recursive: true });
    await writeFile(path.join(staging, "profile.md"), prepared.profileText, "utf8");
    for (const file of prepared.files) {
      const target = path.join(staging, "knowledge", ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, "utf8");
    }

    const stored = JSON.parse(
      await readFile(path.join(prepared.record.directory, "context.json"), "utf8")
    );
    const now = new Date().toISOString();
    const manifest = {
      ...stored,
      schema: CONTEXT_SCHEMA,
      id: prepared.record.id,
      name: prepared.record.name,
      profileFile: "profile.md",
      createdAt: prepared.record.createdAt ?? stored.createdAt ?? now,
      updatedAt: now,
      revision: prepared.record.revision + 1,
      routingDescription: prepared.useWhen,
      extensions: serializeExtensionDeclarations(prepared.declarations),
      routingQuestions: prepared.questions,
      routingEntities: prepared.entities,
      updatedFrom:
        typeof capture.updatedFrom === "string" && capture.updatedFrom.trim().length > 0
          ? capture.updatedFrom.trim()
          : "conversation"
    };
    // `...stored` carries the legacy `kind: "lite"` marker through, and it is
    // kept on purpose for a bundle that already had one. A release predating
    // the unified Context model shares this store and accepts a manifest only
    // when that marker is present — it never looks at the schema — so dropping
    // it here would make the context disappear from every host still on that
    // release, the moment it was updated from a newer one. Readers here ignore
    // it at the current schema, so the same file satisfies both.
    if (prepared.record.knowledgeManaged) {
      manifest.knowledgeFolder = "knowledge";
      manifest.knowledgeManaged = true;
      delete manifest.conversationKnowledgeFolder;
    } else {
      manifest.knowledgeFolder = stored.knowledgeFolder;
      manifest.knowledgeManaged = false;
      manifest.conversationKnowledgeFolder = "knowledge";
    }
    await writeFile(
      path.join(staging, "context.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    // Recheck after staging so a hand edit made during preparation is not
    // replaced. Other save processes respect the lock; this catches everything
    // outside that protocol.
    requireCurrentBase(
      prepared.record,
      await fingerprintContext(prepared.record),
      capture.baseHash
    );

    await replaceContextDirectory(prepared.record.directory, staging, backup);

    return {
      record: recordFor(prepared.record.directory, manifest),
      profileText: prepared.profileText,
      routingDescription: prepared.useWhen,
      knowledgeFileCount: prepared.files.length,
      changes: prepared.changes,
      profileChanged: prepared.profileChanged,
      routingChanged: prepared.routingChanged,
      extensionsChanged: prepared.extensionsChanged
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }
}

// A captured context is already an export bundle. Import reads only the
// portable, generated shape and creates a fresh local id, so a teammate can
// keep the shared folder unchanged and can rename the local copy if necessary.
export async function importCapturedContext({ bundleFolder, name }) {
  const supplied = (bundleFolder ?? "").trim();
  if (supplied.length === 0) {
    throw new ContextError("A captured context bundle folder is required.");
  }
  const source = path.resolve(supplied);
  if (!(await directoryExists(source))) {
    throw new ContextError(`No captured context bundle at ${source}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(source, "context.json"), "utf8"));
  } catch {
    throw new ContextError(`Could not read a valid context.json from ${source}.`);
  }
  if (
    !(
      // As in recordFor: a vestigial `kind` alongside the current schema is
      // ignorable, so a bundle an older build upgraded is still importable.
      manifest?.schema === CONTEXT_SCHEMA ||
      (manifest?.schema === LEGACY_SCHEMA && manifest.kind === "lite")
    ) ||
    manifest.knowledgeManaged !== true ||
    manifest.knowledgeFolder !== "knowledge" ||
    !isConversationCapture(manifest.capturedFrom)
  ) {
    throw new ContextError(
      "That folder is not a portable conversation context bundle."
    );
  }

  let profile;
  try {
    profile = await readFile(path.join(source, "profile.md"), "utf8");
  } catch {
    throw new ContextError("The captured context bundle has no readable profile.md.");
  }

  const knowledgeFolder = path.join(source, "knowledge");
  const { files, truncated } = await listKnowledgeFiles(knowledgeFolder, {
    limit: MAX_CAPTURE_FILES + 1
  });
  if (truncated || files.length > MAX_CAPTURE_FILES) {
    throw new ContextError(
      `The captured context bundle has more than ${MAX_CAPTURE_FILES} knowledge files.`
    );
  }
  const knowledge = [];
  for (const file of files) {
    knowledge.push({
      path: file,
      content: await readFile(path.join(knowledgeFolder, ...file.split("/")), "utf8")
    });
  }

  return createCapturedContext({
    name: typeof name === "string" && name.trim().length > 0 ? name : manifest.name,
    profile,
    routingDescription: manifest.routingDescription,
    // The point of keeping these in the bundle: a teammate's copy is findable
    // by the same words as the original, without them rediscovering any of it.
    routingQuestions: manifest.routingQuestions,
    routingEntities: manifest.routingEntities,
    knowledge,
    // What the bundle says it expects to reach, reduced to declarations. The
    // import creates no binding for any of them, so the imported context arrives
    // able to say what it wants and unable to run anything until this machine's
    // owner says otherwise.
    extensions: readExtensionDeclarations(manifest.extensions),
    capturedFrom: manifest.capturedFrom
  });
}

// Rewrites only the declarations on a context's manifest, in place. This is the
// authoring path — `extensions add` and `extensions remove` — and it is
// deliberately narrow: it touches no knowledge, no profile, and no timestamps
// other than `updatedAt`.
export async function setContextExtensions(record, declarations) {
  const serialized = serializeExtensionDeclarations(declarations);
  const manifestPath = path.join(record.directory, "context.json");
  const temporaryPath = path.join(
    record.directory,
    `.context-extensions-${randomBytes(6).toString("hex")}.json`
  );
  try {
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifest = { ...stored, updatedAt: new Date().toISOString() };
    if (serialized) manifest.extensions = serialized;
    else delete manifest.extensions;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporaryPath, manifestPath);
    return recordFor(record.directory, manifest);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Kept separate so the torn-copy guard is directly testable: the race it catches
// — a hand edit landing while the bundle is being copied — cannot be staged
// deterministically through the command line.
export function requireUnchangedExport(record, before, after) {
  if (before !== after) {
    throw new ContextError(
      `The "${record.name}" context changed while it was being exported. Run the export again.`
    );
  }
}

// Copies a saved context's bundle to a folder the user picks. A conversation
// context is already portable — relative paths, generated knowledge inside the
// bundle — so export is a copy rather than a conversion, and what lands is
// exactly the shape `importCapturedContext` reads back.
//
// A `/create` context is refused instead of half-exported. Its knowledge is a
// folder this plugin references but does not own, so carrying it would mean
// copying files the user never handed over, and leaving it behind would ship a
// bundle whose knowledge is silently missing on the other machine.
export async function exportContext({ record, destination, force = false, routingDescription }) {
  if (!record) {
    throw new ContextError("No context was selected for export.");
  }
  if (!record.knowledgeManaged) {
    throw new ContextError(
      `"${record.name}" links a knowledge folder this plugin does not own ` +
        `(${record.knowledgeFolder}), so it cannot be exported as a self-contained ` +
        "bundle. Copy that folder to the other machine yourself and re-create the " +
        "context there with `/neatcontext:create`. Contexts saved from a conversation " +
        "own their knowledge and export in full."
    );
  }

  const supplied = (destination ?? "").trim();
  if (supplied.length === 0) {
    throw new ContextError("An export destination folder is required.");
  }
  const parent = path.resolve(supplied);
  if (isInside(record.directory, parent)) {
    throw new ContextError(
      "The export destination is inside the context being exported. Pick a folder outside it."
    );
  }
  // An exported copy under the Context home would be read back as a
  // second context carrying the same id, which makes `use` and `delete`
  // ambiguous. Export writes bundles for elsewhere; import is what brings one in.
  if (isInside(contextHome(), parent) || isInside(legacyContextHome(), parent)) {
    throw new ContextError(
      "The export destination is inside NeatContext's own context storage. Pick a folder " +
        "outside it — use `/neatcontext:import` to bring a bundle back in."
    );
  }

  const target = path.join(parent, path.basename(record.directory));
  const replacing = await directoryExists(target);
  if (replacing && !force) {
    throw new ContextError(
      `${target} already exists. Re-run the export with --force to replace it.`
    );
  }

  // The lock is the same one `/save` takes, so an export cannot copy a bundle
  // that is being replaced underneath it.
  const release = await acquireUpdateLock(record);
  const suffix = randomBytes(6).toString("hex");
  const staging = path.join(parent, `.neatcontext-export-${suffix}`);
  const backup = path.join(parent, `.neatcontext-export-backup-${suffix}`);
  try {
    await mkdir(parent, { recursive: true });
    const before = await fingerprintContext(record);
    await cp(record.directory, staging, { recursive: true, errorOnExist: true, force: false });

    // The lock stops a concurrent save; this catches a hand edit made while the
    // copy was running, which would otherwise publish a torn bundle.
    requireUnchangedExport(record, before, await fingerprintContext(record));

    const useWhen = (routingDescription ?? "").trim();
    const manifestPath = path.join(staging, "context.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.schema = CONTEXT_SCHEMA;
    manifest.profileFile = "profile.md";
    delete manifest.kind;
    // The last point at which this machine's copy becomes someone else's. Run
    // the declarations back through the whitelist here, so whatever a hand edit
    // may have added beside them — a command, an environment, a token — is not
    // what leaves the building.
    const declarations = serializeExtensionDeclarations(
      readExtensionDeclarations(manifest.extensions)
    );
    if (declarations) manifest.extensions = declarations;
    else delete manifest.extensions;
    if (useWhen.length > 0) manifest.routingDescription = useWhen;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (replacing) {
      await replaceContextDirectory(target, staging, backup);
    } else {
      await rename(staging, target);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }

  const { files } = await listKnowledgeFiles(path.join(target, "knowledge"));
  return { record, destination: target, knowledgeFileCount: files.length, replaced: replacing };
}

// Removes the context directory. A `/create` context only points at the user's
// knowledge folder, so that folder is left alone. A `/save` context owns its
// generated knowledge inside this directory, so it is removed with the bundle.
export async function deleteContext(id) {
  const record = await readContext(id);
  if (!record) {
    return null;
  }
  await rm(record.directory, { recursive: true, force: true });
  return record;
}

// A shallow, capped listing of the knowledge folder. The plugin has no index or
// retrieval engine: this listing is what turns the client's own file tools from
// blind globbing into targeted reads.
export async function listKnowledgeFiles(folder, { limit = MAX_LISTED_FILES } = {}) {
  const files = [];
  let truncated = false;

  async function walk(directory, relative, depth) {
    if (truncated || depth > MAX_LISTING_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) {
        return;
      }
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const child = relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), child, depth + 1);
      } else if (entry.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(child);
      }
    }
  }

  await walk(folder, "", 0);
  return { files, truncated };
}

function escapeMarkdown(value) {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function pathEntry(target) {
  if (path.isAbsolute(target) && !/[\r\n<>`]/.test(target)) {
    return `[\`${target}\`](${pathToFileURL(target).href})`;
  }
  return target;
}

export const CONTEXT_MISSING_MESSAGE =
  "The context this session was using no longer exists on disk. Choose another context " +
  "or create a new one.";

// The `get_context` payload contains pointers to files that the client reads
// itself; knowledge content is never copied into the response.
export async function renderContext(record) {
  const name = escapeMarkdown(record.name);
  const lines = [
    `# NeatContext — connected context: ${name}`,
    "",
    `You are answering with the "${name}" context. Ground every answer in the ` +
      "domain profile and the local knowledge folder below. When those sources do not " +
      "cover the question, say so instead of guessing.",
    "",
    "## Domain profile (read this file in full before answering)",
    "",
    "It is your primary behavioral guide: it states what this context is for, what to " +
      "do, what to avoid, and how to behave.",
    "",
    `- ${pathEntry(record.profilePath)}`,
    "",
    "## Local knowledge folder (search it with your own file tools)",
    ""
  ];

  const folderExists = record.knowledgeFolder.length > 0 && (await directoryExists(record.knowledgeFolder));
  if (!folderExists) {
    lines.push(
      `The knowledge folder for this context (\`${record.knowledgeFolder}\`) is missing — it ` +
        "was moved, renamed, or is on a drive that is not mounted. Tell the user, and answer " +
        "from the domain profile alone until it is back."
    );
  } else {
    lines.push(`- ${pathEntry(record.knowledgeFolder)}`);
    lines.push("");
    const { files, truncated } = await listKnowledgeFiles(record.knowledgeFolder);
    if (files.length === 0) {
      lines.push(
        "The folder is empty. Tell the user to put the team's TSGs, runbooks, or docs in " +
          "it, then ask again."
      );
    } else {
      lines.push(
        truncated
          ? `Its first ${files.length} files (there are more — search the folder for anything not listed):`
          : `Its files (${files.length}):`
      );
      lines.push("");
      for (const file of files) {
        lines.push(`- ${file}`);
      }
    }
  }

  if (!record.knowledgeManaged && record.conversationKnowledgeFolder) {
    const { files } = await listKnowledgeFiles(record.conversationKnowledgeFolder);
    if (files.length > 0) {
      lines.push("");
      lines.push("## Conversation knowledge saved into this context");
      lines.push("");
      lines.push(`- ${pathEntry(record.conversationKnowledgeFolder)}`);
      lines.push("");
      lines.push(`Its files (${files.length}):`);
      lines.push("");
      for (const file of files) {
        lines.push(`- ${file}`);
      }
    }
  }

  lines.push("");
  lines.push("## Rules");
  lines.push(
    '- Cite the exact file path when you rely on a source; never shorten a path with "...".'
  );
  lines.push("- Prefer these local sources over general knowledge for anything domain-specific.");
  lines.push("- This context provides one profile and local knowledge.");
  // Session instructions are fixed at the handshake, so a session that started
  lines.push(
    "- This is not an incident context unless the profile above says so. The domain " +
      "profile defines the behavior and the shape of the answer."
  );

  return lines.join("\n");
}
