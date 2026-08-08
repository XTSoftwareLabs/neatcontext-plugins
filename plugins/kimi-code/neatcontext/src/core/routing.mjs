// Routing: the metadata a session uses to pick its own context.
//
// No process in this plugin has a model, so none of them classify prompts.
// What they do is publish a menu — one line per context, saying what that
// context is for — and let the session's own model route from it. That is how
// Coding hosts route skills, and a context is close enough to a skill for the
// same mechanism to work: cheap metadata always present, the expensive content
// (the profile, the knowledge folder) fetched only once something is chosen.
//
// The line is derived from the domain profile by the model, at creation time,
// and cached here. Deriving beats asking the user for it: a profile is a far
// richer input than an answer to "when should I use this?", and derived lines
// come out consistent in style and granularity — which is what makes them
// comparable when the model ranks one against another.
//
// Where a skill and a context differ is the cost of being wrong. Invoking the
// wrong skill wastes a few tokens; switching to the wrong context re-grounds
// the session and swaps the tool list, and the answer that follows is confident
// and sourced from the wrong team's documents. Mode, cooldown, and the decision
// log all exist to keep that mistake cheap.
//
// One file in the local NeatContext data directory. Tests can redirect the
// directory with NEATCONTEXT_HOME.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { neatContextHome } from "./storage-home.mjs";
import { sessionId } from "./session.mjs";

export { sessionId };

export const MODES = ["auto", "ask", "manual"];
export const DEFAULT_MODE = "ask";

const SCHEMA = 1;
const MAX_USE_WHEN = 240;
const MAX_ALIASES = 12;
const MAX_DECISIONS = 100;
const MAX_SESSIONS = 20;

export function routingFilePath() {
  return path.join(neatContextHome(), "plugin-routing.json");
}

export function hashSource(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex").slice(0, 16);
}

function normalizeCard(raw) {
  if (typeof raw?.useWhen !== "string") {
    return null;
  }
  return {
    useWhen: raw.useWhen.slice(0, MAX_USE_WHEN),
    aliases: Array.isArray(raw.aliases)
      ? raw.aliases.filter((alias) => typeof alias === "string").slice(0, MAX_ALIASES)
      : [],
    sourceHash: typeof raw.sourceHash === "string" ? raw.sourceHash : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

// A missing or hand-broken file is not an error: routing is an enhancement, and
// losing it must never stop a session from being grounded the manual way.
export async function readRouting() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(routingFilePath(), "utf8"));
  } catch {
    parsed = null;
  }
  const cards = {};
  for (const [id, raw] of Object.entries(parsed?.cards ?? {})) {
    const card = normalizeCard(raw);
    if (card) {
      cards[id] = card;
    }
  }
  return {
    schema: SCHEMA,
    mode: MODES.includes(parsed?.mode) ? parsed.mode : DEFAULT_MODE,
    cards,
    sessions: typeof parsed?.sessions === "object" && parsed.sessions !== null ? parsed.sessions : {},
    decisions: Array.isArray(parsed?.decisions) ? parsed.decisions : []
  };
}

async function writeRouting(state) {
  // Sessions accumulate forever otherwise — one per host window, ever.
  const sessions = Object.entries(state.sessions)
    .sort((a, b) => (b[1]?.updatedAt ?? "").localeCompare(a[1]?.updatedAt ?? ""))
    .slice(0, MAX_SESSIONS);
  const file = routingFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ ...state, sessions: Object.fromEntries(sessions), decisions: state.decisions.slice(-MAX_DECISIONS) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

async function update(mutate) {
  const state = await readRouting();
  const result = mutate(state);
  await writeRouting(state);
  return result;
}

// The read-mutate-write cycle, for state this module does not interpret. The
// save nudge keeps its counters inside `sessions[id].save` — same file, same
// session cap, same 0600 — without this module having to know their shape.
export function updateRouting(mutate) {
  return update(mutate);
}

// --- cards -------------------------------------------------------------------

// `source` is the text the line was derived from. Its hash is what later tells
// us the line has drifted from a profile the user edited by hand.
export function putCard(contextId, { useWhen, source, aliases }) {
  return update((state) => {
    const existing = state.cards[contextId];
    state.cards[contextId] = {
      useWhen: (useWhen ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_USE_WHEN),
      aliases: (aliases ?? existing?.aliases ?? []).slice(0, MAX_ALIASES),
      sourceHash: source === undefined ? (existing?.sourceHash ?? null) : hashSource(source),
      updatedAt: new Date().toISOString()
    };
    return state.cards[contextId];
  });
}

// The correction loop, and the only routing signal the user authors directly.
// It is captured when routing has just been wrong, which is both the moment the
// user is most able to say what the missing word was and the moment they were
// going to type it anyway.
export function addAlias(contextId, alias) {
  const clean = (alias ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (clean.length === 0) {
    return Promise.resolve(null);
  }
  return update((state) => {
    const card = state.cards[contextId] ?? { useWhen: "", aliases: [], sourceHash: null };
    if (!card.aliases.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
      card.aliases = [...card.aliases, clean].slice(-MAX_ALIASES);
    }
    card.updatedAt = new Date().toISOString();
    state.cards[contextId] = card;
    return clean;
  });
}

// A card whose profile has been rewritten since it was derived. The plugin
// cannot regenerate it — there is no model here — so the staleness is surfaced
// to the session, which has one and can do it inline.
export function isCardStale(card, source) {
  return Boolean(card?.sourceHash) && typeof source === "string" && card.sourceHash !== hashSource(source);
}

// --- mode --------------------------------------------------------------------

// Global default, overridden per session. A mode is a property of what you are
// doing right now, not of the machine: one window deep in an incident wants
// auto, another window writing code wants to be left alone.
export function resolveMode(state, id) {
  const session = id ? state.sessions[id] : null;
  return MODES.includes(session?.mode) ? session.mode : state.mode;
}

export function setMode(mode, { global: isGlobal = false, id = sessionId() } = {}) {
  if (!MODES.includes(mode)) {
    return Promise.resolve(null);
  }
  return update((state) => {
    if (isGlobal || !id) {
      state.mode = mode;
      // A global change the user asked for should not be masked by an override
      // this session set earlier.
      if (id && state.sessions[id]) {
        delete state.sessions[id].mode;
      }
      return { mode, scope: "global" };
    }
    state.sessions[id] = { ...state.sessions[id], mode, updatedAt: new Date().toISOString() };
    return { mode, scope: "session" };
  });
}

// --- policy ------------------------------------------------------------------

// Enforced here rather than by the host's tool permissions, which are coarse:
// they can allow or deny the tool, but the answer depends on the mode, on what
// the user just declined, and on how much switching this session has already
// done. Allow the tool once, and let this decide.
export function switchPolicy(state, { id, targetId, connectedId, requested = false }) {
  const mode = resolveMode(state, id);
  if (targetId === connectedId) {
    return { allowed: false, mode, reason: "already-connected" };
  }
  // An explicit "switch to X" is the user routing by hand through a different
  // door, and manual is the one mode that means the plugin never routes at all.
  if (requested) {
    return { allowed: true, mode, reason: "user-requested" };
  }
  if (mode === "manual") {
    return { allowed: false, mode, reason: "manual-mode" };
  }
  if (mode === "ask") {
    return { allowed: false, mode, reason: "ask-first" };
  }
  const session = (id && state.sessions[id]) ?? {};
  if ((session.declined ?? []).includes(targetId)) {
    return { allowed: false, mode, reason: "declined-this-session" };
  }
  return { allowed: true, mode, reason: "auto" };
}

// Remembering a refusal is what stops auto mode from proposing the same wrong
// context on every message that shares a word with it.
export function noteDeclined(targetId, { id = sessionId() } = {}) {
  if (!id) {
    return Promise.resolve(null);
  }
  return update((state) => {
    const session = state.sessions[id] ?? {};
    const declined = session.declined ?? [];
    state.sessions[id] = {
      ...session,
      declined: declined.includes(targetId) ? declined : [...declined, targetId],
      updatedAt: new Date().toISOString()
    };
    return targetId;
  });
}

// Every switch, with what it was routing away from and why. Thresholds and card
// quality are guesses until this has something in it: manual selections are the
// ground truth that says whether the derived lines actually route correctly.
export function noteDecision(entry) {
  return update((state) => {
    state.decisions.push({ at: new Date().toISOString(), ...entry });
    const id = entry.sessionId;
    if (id) {
      const session = state.sessions[id] ?? {};
      state.sessions[id] = {
        ...session,
        switches: (session.switches ?? 0) + 1,
        updatedAt: new Date().toISOString()
      };
    }
    return entry;
  });
}

// --- the menu ----------------------------------------------------------------

function describe(entry) {
  const parts = [];
  if (entry.useWhen) {
    parts.push(entry.useWhen);
  }
  if (entry.aliases?.length > 0) {
    parts.push(`also called: ${entry.aliases.join(", ")}`);
  }
  if (parts.length === 0) {
    return "no description yet — connect it once and derive one from its profile";
  }
  return parts.join(" — ");
}

// One line per context, the way skills are advertised: enough to route on,
// never enough to act on. Deliberately no behavioral text from any profile —
// an instruction from a context you are *not* connected to is still an
// instruction sitting in the window, and it would bleed into how the session
// answers on the context you are.
export function renderMenu(entries, { connectedId, mode } = {}) {
  if (mode === "manual" || entries.length === 0) {
    return null;
  }
  const lines = ["## Contexts available on this machine", ""];
  for (const entry of entries) {
    const marker = entry.id === connectedId ? " **(connected)**" : "";
    lines.push(`- **${entry.name}**${marker} — ${describe(entry)}`);
  }
  lines.push("");
  lines.push(...routingInstructions(mode));
  return lines.join("\n");
}

// Shared with the shortlist below, because a shortlist is still a menu: the
// same model still decides, still asks first in ask mode, and still must not
// route on a follow-up. Only the number of things it chooses between differs.
function routingInstructions(mode) {
  return [
    mode === "auto"
      ? "Routing is on (auto). When the user's request clearly belongs to one of the other contexts above, switch to it with the `use_context` tool, then call `get_context` and answer from what it returns. Say in one line that you switched, and which context you are now on. When two contexts are both plausible, do not guess — name them and ask which one."
      : "Routing is on (ask). When the user's request clearly belongs to one of the other contexts above, say so and ask before switching — never switch first. If they agree, call `use_context`, then `get_context`, and answer from what it returns.",
    "Do not route on follow-ups, short replies, or anything that continues the current topic — a switch needs a request that stands on its own and plainly belongs elsewhere. If the user declines a switch, drop it and do not raise that context again this session.",
    "When the user corrects a wrong route, pass what they called it as `alias` to `use_context` so the same words route correctly next time."
  ];
}

// The same menu, cut down to what the request actually reached.
//
// Two things change against the full list. It is short, so each entry can
// afford to say why it is there — the words from the request that landed — and
// a session choosing between two of them has something to read besides its own
// impression. And it is in match order rather than alphabetical, which is the
// order a reader wanted in the first place.
//
// The absence of a context is information too, so the list says so outright.
// Left unsaid, a short list reads like the whole store, and a model that cannot
// find what it wants in it starts reaching for the closest thing there.
export function renderShortlist(entries, { connectedId, mode, decision } = {}) {
  if (mode === "manual" || entries.length === 0) {
    return null;
  }
  const lines = ["## Contexts that match what the user just asked", ""];
  for (const entry of entries) {
    const marker = entry.id === connectedId ? " **(connected)**" : "";
    lines.push(`- **${entry.name}**${marker} — ${describe(entry)}${matchNote(entry)}`);
  }
  lines.push("");
  lines.push(
    "These are the contexts on this machine whose own description matched the request, best first. Others exist and did not match — that is a reason to stay where you are, not to reach for the closest one here."
  );
  const tie = tieNote(decision);
  if (tie) {
    lines.push(tie);
  }
  lines.push(...routingInstructions(mode));
  return lines.join("\n");
}

// What a near-tie is allowed to do, which is nothing on its own.
//
// This overrides auto deliberately. Auto is the mode for "act when it is
// obvious", and two contexts matching equally well is the definition of not
// obvious — the one case where switching unasked is most likely to be wrong and
// least likely to be noticed, because the answer that follows is fluent and
// sourced and simply about the wrong thing.
function tieNote(decision) {
  if (decision?.verdict !== "close") {
    return null;
  }
  const names = decision.leaders.map((leader) => `**${leader.name}**`).join(" and ");
  return (
    `${names} match the request about equally well, so which one is right is not something to ` +
    "decide on the user's behalf. Name them, say in one line what each covers, and ask which — " +
    "in auto mode too. Switch only once they have answered."
  );
}

function matchNote(entry) {
  if (!Array.isArray(entry.matched) || entry.matched.length === 0) {
    return "";
  }
  return ` _(matched: ${entry.matched.join(", ")})_`;
}

// Merges what exists right now with what has been derived about it. The context
// list is the authority on what exists — a card outliving its context must not
// put a dead entry on the menu.
export function menuEntries(contexts, state) {
  return contexts.map((context) => ({
    id: context.id,
    name: context.name,
    // Captured contexts carry their routing description in the portable
    // bundle as well as in this machine's routing cache. The embedded copy is
    // what makes a teammate's imported bundle routable before they have ever
    // connected it.
    useWhen: state.cards[context.id]?.useWhen || context.routingDescription || "",
    aliases: state.cards[context.id]?.aliases ?? []
  }));
}
