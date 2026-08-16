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

// Auto, because asking is now something a route decides rather than something
// the mode does. When there is no way to tell an obvious match from a coin
// flip, "ask first" is the only safety net available and has to be on for
// everyone — including the nine times in ten the answer is plain. Once the
// shortlist can see how far ahead the leader is, the net moves into the
// decision: a clear match switches, a near-tie asks, nothing matching stays put.
// Asking every time then costs a question per turn and buys nothing.
export const DEFAULT_MODE = "auto";

// 2 marks the file as one where a stored mode means somebody chose it. See
// `chosenMode` for what schema 1 got wrong and why it cannot be read literally.
const SCHEMA = 2;
export const MAX_USE_WHEN = 240;
const MAX_ALIASES = 12;
const MAX_DECISIONS = 100;

// Automatic routes are capped separately, and far shorter.
//
// They arrive at roughly one per new session, so a single shared cap would see
// them evict the manual selections this log exists for — and `familiarity`
// skipping them is exactly what would keep anyone from noticing the ground
// truth had drained away. Manual decisions keep their own hundred; the machine
// ones keep a short tail, which is all that is ever read back when working out
// why a session routed the way it did.
const MAX_AUTOMATIC_DECISIONS = 20;
const MAX_SESSIONS = 20;

// How long a refusal keeps counting for.
//
// "Not that one" is true tomorrow as well, so forgetting it when the window
// closes throws away the clearest signal the user ever gives. But it is
// evidence, not a rule: a context refused during one week's work should not be
// unreachable a quarter later. So it fades — half its strength every two weeks,
// negligible by six — and refusing the same context again resets the clock and
// deepens it, which is the escalation a browser uses for a permission prompt
// dismissed several times over. Once is noise; three times is an answer.
//
// Nothing here ever becomes permanent. The only permanent no in this plugin is
// manual mode, because that one is a decision the user made on purpose.
// How much a context you actually use is worth.
//
// The same idea a browser address bar runs on: you type two letters and it
// offers the site you open daily, not the one you opened once last year. It
// solves the same problem routing has — many items, a short vague request, and
// one chance to be right.
//
// Deliberately a small thumb on the scale rather than a decision. What you used
// last week is a hint about what you mean; it is not evidence about what you
// asked, and it must never outrank the words.
const FRECENCY_HALF_LIFE_DAYS = 14;
const FRECENCY_MAX_BOOST = 1.25;

// And how much the context you are already on is worth.
//
// Most requests continue the last one, so leaving is the unusual move and
// should need more evidence than staying. Handing the session to a context that
// is barely ahead is how a conversation ends up flipping between two of them.
//
// This is hysteresis, and it needs no new machinery: inflating the incumbent's
// score means a challenger has to clear it by a real margin, and one that only
// just clears it lands inside the near-tie rule and becomes a question instead
// of a switch.
const STICKY_BOOST = 1.35;

const DECLINE_HALF_LIFE_DAYS = 14;
const DECLINE_LIFETIME_DAYS = 42;

// How long a refusal bars connecting unasked, as opposed to merely discounting
// the score. See `hasLiveDecline` for why the two differ.
const LIVE_DECLINE_DAYS = DECLINE_HALF_LIFE_DAYS;
const DECLINE_WEIGHT = 0.4;
const MAX_DECLINE_COUNT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const declines = {};
  for (const [id, raw] of Object.entries(parsed?.declines ?? {})) {
    if (typeof raw?.at === "string" && Number.isInteger(raw.count) && raw.count > 0) {
      declines[id] = { at: raw.at, count: Math.min(raw.count, MAX_DECLINE_COUNT) };
    }
  }
  return {
    schema: SCHEMA,
    declines,
    mode: chosenMode(parsed),
    cards,
    sessions: typeof parsed?.sessions === "object" && parsed.sessions !== null ? parsed.sessions : {},
    decisions: Array.isArray(parsed?.decisions) ? parsed.decisions : []
  };
}

// The mode the user actually chose, or null when nobody has.
//
// Null is not a synonym for the default, and the difference is the whole point.
// Until schema 2 the *resolved* mode was written back on every routing write —
// deriving a card, logging a decision, noting a refusal — so a file ended up
// stating whatever the default happened to be in the build that last touched
// it. "ask" was that default until the shortlist learned to ask on its own, so
// every machine that had ever saved a context had "ask" written down, and
// changing the default to "auto" reached none of them. Routing looked switched
// off on exactly the machines that used it most, and reinstalling did not help:
// this file lives in ~/.neatcontext and outlives any one plugin install.
//
// So an "ask" in a pre-schema-2 file is not evidence of a choice, and is
// dropped. A machine where it genuinely was one loses it once, and a single
// `/neatcontext:mode ask --global` puts it back — written under schema 2 this
// time, where a stored mode means somebody asked for it. "manual" is never a
// default, so it was always deliberate and always stands.
function chosenMode(parsed) {
  if (!MODES.includes(parsed?.mode)) {
    return null;
  }
  if (parsed.schema !== SCHEMA && parsed.mode === "ask") {
    return null;
  }
  return parsed.mode;
}

async function writeRouting(state) {
  // Sessions accumulate forever otherwise — one per host window, ever.
  const sessions = Object.entries(state.sessions)
    .sort((a, b) => (b[1]?.updatedAt ?? "").localeCompare(a[1]?.updatedAt ?? ""))
    .slice(0, MAX_SESSIONS);
  const file = routingFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const { mode, ...rest } = state;
  await writeFile(
    file,
    `${JSON.stringify(
      {
        ...rest,
        // Written down only when somebody chose it. An unchosen mode stays out
        // of the file entirely, so this machine keeps following the default
        // rather than pinning whichever one this build happens to ship.
        ...(MODES.includes(mode) ? { mode } : {}),
        sessions: Object.fromEntries(sessions),
        declines: pruneDeclines(state.declines, Date.now()),
        decisions: capDecisions(state.decisions)
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

// Trimmed in two buckets rather than one, so the machine's own routes cannot
// push the user's out of the record. Merged back in time order afterwards,
// because everything downstream reads this as a chronology.
function capDecisions(decisions) {
  const manual = [];
  const automatic = [];
  for (const decision of decisions) {
    (decision?.automatic === true ? automatic : manual).push(decision);
  }
  return mergeByTime(manual.slice(-MAX_DECISIONS), automatic.slice(-MAX_AUTOMATIC_DECISIONS));
}

// Where a decision sits in the log, for a decision whose `at` will not parse.
//
// It sits where it already was. `Date.parse` returns NaN for a hand-edited
// entry, a half-written one, or one from a future writer that spells the field
// differently, and `NaN || 0` reads that as the first of January 1970 — which
// sorts it to the front of the log and, because this runs on every write,
// leaves it there for good. One unreadable timestamp then permanently rewrites
// the chronology `familiarity` and every "why did it route that way?" read
// back off this file.
//
// Each bucket is already in the order it was appended, so carrying the last
// timestamp forward within it keeps such an entry beside the decisions it was
// actually made among — the only evidence about it that is left.
function timeKeys(bucket) {
  let last = -Infinity;
  return bucket.map((decision) => {
    const parsed = Date.parse(decision?.at);
    if (Number.isFinite(parsed)) {
      last = parsed;
    }
    return last;
  });
}

// A merge rather than a sort, because both sides arrive ordered and a merge is
// the one way to interleave them that cannot move anything within its own side.
function mergeByTime(left, right) {
  const leftKeys = timeKeys(left);
  const rightKeys = timeKeys(right);
  const merged = [];
  let l = 0;
  let r = 0;
  while (l < left.length && r < right.length) {
    merged.push(leftKeys[l] <= rightKeys[r] ? left[l++] : right[r++]);
  }
  return [...merged, ...left.slice(l), ...right.slice(r)];
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
  if (MODES.includes(session?.mode)) {
    return session.mode;
  }
  // `state.mode` is null on a machine where nobody has set one, which is what
  // lets the default below actually apply.
  return MODES.includes(state.mode) ? state.mode : DEFAULT_MODE;
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
//
// Two records, because a refusal means two different things. Inside the session
// it is absolute — that context is not raised again, full stop. Outside it, it
// is evidence that fades: the same request should still reach the same context
// eventually, just not today and not without something better to go on.
export function noteDeclined(targetId, { id = sessionId(), now = new Date() } = {}) {
  return update((state) => {
    const previous = state.declines[targetId];
    state.declines[targetId] = {
      at: now.toISOString(),
      // Repeating a refusal restarts the clock and deepens it, rather than
      // simply re-stating what was already known.
      count: Math.min((previous?.count ?? 0) + 1, MAX_DECLINE_COUNT)
    };
    if (id) {
      const session = state.sessions[id] ?? {};
      const declined = session.declined ?? [];
      state.sessions[id] = {
        ...session,
        declined: declined.includes(targetId) ? declined : [...declined, targetId],
        updatedAt: now.toISOString()
      };
    }
    return targetId;
  });
}

// What a past refusal does to a context's score now: a multiplier in (0, 1],
// where 1 means it is not holding anything back.
//
// Strength halves every two weeks, so a fresh single refusal costs a candidate
// most of its lead and a six-week-old one costs it almost nothing. Repeats
// compound rather than add, which keeps the result inside the range however
// many there have been.
export function declineFactor(state, contextId, now = new Date()) {
  const entry = state.declines?.[contextId];
  if (!entry) {
    return 1;
  }
  const days = (now.getTime() - Date.parse(entry.at)) / DAY_MS;
  if (!Number.isFinite(days) || days >= DECLINE_LIFETIME_DAYS) {
    return 1;
  }
  const strength = DECLINE_WEIGHT * 0.5 ** (Math.max(days, 0) / DECLINE_HALF_LIFE_DAYS);
  return (1 - strength) ** entry.count;
}

// Whether a refusal is recent enough to forbid connecting without being asked.
//
// Deliberately not `declineFactor(...) < 1`. That reads a veto off a floating
// point comparison, and it is true for the whole six weeks the multiplier takes
// to decay: at day 41 the factor is about 0.99, a discount the ranking treats
// as no discount at all, while the gate was treating it as an absolute bar. It
// also leaves the threshold — the thing a reader most needs to know — implicit
// in a value nothing names.
//
// One half-life is where the line goes. For that long a refusal still carries
// most of the weight it was given, and connecting unasked is the one route the
// user gets no chance to stop. Past it, the multiplier is the whole answer: a
// faded refusal is a hint, and the ranking is where hints belong.
//
// A timestamp from the future counts as live, matching how `declineFactor`
// floors the age at zero. Both err towards not acting.
export function hasLiveDecline(state, contextId, now = new Date()) {
  const at = Date.parse(state?.declines?.[contextId]?.at);
  if (!Number.isFinite(at)) {
    return false;
  }
  return (now.getTime() - at) / DAY_MS < LIVE_DECLINE_DAYS;
}

// How much this machine's own history argues for a context: a multiplier at or
// above 1, never below, because this is a hint and not evidence.
//
// Both halves are personal. They read what this machine has done and change
// nothing in the bundle, so a context stays exactly as portable as it was — two
// people will simply reach it in a slightly different order, which is the
// honest answer when one of them lives in it and the other has never opened it.
//
// Matched on name rather than id because that is what the decision log records.
// Names are unique in a store, so this is exact; renaming a context forgets its
// history, which for a hint of this size is a fair trade against threading an
// id through five hosts' bridges.
//
// Routes the plugin made for itself are skipped. They are in the log because
// the log is the record of what happened, but they are not evidence about this
// user: reading them back would raise the multiplier of a context this machine
// chose on a keyword hit, making the same choice likelier next time and the one
// after — a mis-route that argues for itself. Only what a person or a model
// decided counts as familiarity.
export function familiarity(state, context, { connectedId = null, now = new Date() } = {}) {
  const sticky = context.id === connectedId ? STICKY_BOOST : 1;
  let weight = 0;
  for (const decision of state.decisions ?? []) {
    if (decision?.to !== context.name || decision?.automatic === true) continue;
    const days = (now.getTime() - Date.parse(decision.at)) / DAY_MS;
    if (!Number.isFinite(days) || days < 0) continue;
    weight += 0.5 ** (days / FRECENCY_HALF_LIFE_DAYS);
  }
  // Saturating, so a context used fifty times cannot run away with the ranking
  // and no pass over the whole corpus is needed to normalise anything.
  const used = 1 + (FRECENCY_MAX_BOOST - 1) * (weight / (weight + 1));
  return sticky * used;
}

// Dropped once it can no longer change an outcome, so the file does not
// accumulate a record of every context ever turned down.
function pruneDeclines(declines, now) {
  const kept = {};
  for (const [id, entry] of Object.entries(declines)) {
    const days = (now - Date.parse(entry.at)) / DAY_MS;
    if (Number.isFinite(days) && days < DECLINE_LIFETIME_DAYS) {
      kept[id] = entry;
    }
  }
  return kept;
}

// Every switch, with what it was routing away from and why. Thresholds and card
// quality are guesses until this has something in it: manual selections are the
// ground truth that says whether the derived lines actually route correctly.
//
// Which is why a route the plugin made for itself has to be marked `automatic`
// as it goes in. Left indistinguishable, machine routes accumulate at roughly
// one per new session and the log stops being able to answer the question it is
// kept for. `requested` does not carry that distinction — a model calling
// `use_context` in auto mode records `requested: false` too, and it was still a
// decision somebody made.
export function noteDecision(entry) {
  return update((state) => {
    state.decisions.push({ at: new Date().toISOString(), ...entry });
    const id = entry.sessionId;
    // A session record holds what the user chose for that window: its `mode`
    // override and the contexts they declined in it. Every writer of one used
    // to need a person or a model to act — `setMode`, `noteDeclined`, or a
    // `use_context` call. An automatic route needs neither, and it arrives at
    // about one per new session, so creating a record for one turned the
    // `MAX_SESSIONS` cap into a shredder: twenty windows auto-connecting
    // elsewhere would evict the record of a window where somebody had run
    // `/neatcontext:mode manual`, `resolveMode` would fall through to the
    // default — which is `auto` — and a session where the user had turned
    // routing off would start routing itself again, silently, having also
    // forgotten what they declined there.
    //
    // So an automatic decision keeps a record that already exists up to date,
    // and creates none. The log still has the route: `decisions` is where a
    // machine route belongs, and it is capped in its own bucket.
    if (id && (state.sessions[id] || entry.automatic !== true)) {
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
//
// It takes a `decision` for the same reason the shortlist does. A near-tie is
// something the plugin knows and the model cannot see, and a store too small
// for a shortlist is exactly where the full menu goes out instead — so leaving
// the note behind there means the one caller that most needs it never gets it.
export function renderMenu(entries, { connectedId, mode, decision } = {}) {
  if (mode === "manual" || entries.length === 0) {
    return null;
  }
  const lines = ["## Contexts available on this machine", ""];
  for (const entry of entries) {
    const marker = entry.id === connectedId ? " **(connected)**" : "";
    lines.push(`- **${entry.name}**${marker} — ${describe(entry)}`);
  }
  lines.push("");
  const tie = tieNote(decision);
  if (tie) {
    lines.push(tie, "");
  }
  lines.push(...routingInstructions(mode, Boolean(connectedId)));
  return lines.join("\n");
}

// Shared with the shortlist below, because a shortlist is still a menu: the
// same model still decides, still asks first in ask mode, and still must not
// route on a follow-up. Only the number of things it chooses between differs.
//
// Split on whether anything is connected, because the two situations are not
// the same move. Switching means leaving somewhere, and every guard here —
// "clearly belongs", "not on a follow-up", "stands on its own" — exists to make
// leaving cost something. A session grounded in nothing has nowhere to leave
// from: the same guards read as reasons to do nothing at all, which is how a
// question that plainly belonged to a saved context ended up answered from
// general knowledge with a slash command offered as consolation.
function routingInstructions(mode, connected) {
  return [
    connected ? switchInstruction(mode) : connectInstruction(mode),
    connected
      ? "Do not route on follow-ups, short replies, or anything that continues the current topic — a switch needs a request that stands on its own and plainly belongs elsewhere. If the user declines a switch, drop it and do not raise that context again this session."
      : "There is no current topic to continue and nothing to leave, so connecting the context a request belongs to is the expected move rather than an interruption. If the user declines one, drop it and do not raise that context again this session.",
    "When the user corrects a wrong route, pass what they called it as `alias` to `use_context` so the same words route correctly next time."
  ];
}

function switchInstruction(mode) {
  return mode === "auto"
    ? "Routing is on (auto). When the user's request clearly belongs to one of the other contexts above, switch to it with the `use_context` tool, then call `get_context` and answer from what it returns. Say in one line that you switched, and which context you are now on. When two contexts are both plausible, do not guess — name them and ask which one."
    : "Routing is on (ask). When the user's request clearly belongs to one of the other contexts above, say so and ask before switching — never switch first. If they agree, call `use_context`, then `get_context`, and answer from what it returns.";
}

function connectInstruction(mode) {
  return mode === "auto"
    ? "Routing is on (auto), and this session is grounded in nothing yet. When the user's request belongs to one of the contexts above, connect it with the `use_context` tool, then call `get_context` and answer from what it returns. Do that yourself — do not ask the user to run a command to connect a context you can already name. Say in one line which context you connected. When two contexts are both plausible, do not guess — name them and ask which one."
    : "Routing is on (ask), and this session is grounded in nothing yet. When the user's request belongs to one of the contexts above, name it and ask whether to connect it — never connect first. If they agree, call `use_context`, then `get_context`, and answer from what it returns.";
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
    connectedId
      ? "These are the contexts on this machine whose own description matched the request, best first. Others exist and did not match — that is a reason to stay where you are, not to reach for the closest one here."
      : "These are the contexts on this machine whose own description matched the request, best first. Others exist and did not match — so if none of these covers the request, say the store does not have it rather than reaching for the closest one here."
  );
  // Its own paragraph: it is the one line asking the model to stop and ask,
  // and run together with the instructions around it that is what it stops
  // looking like.
  const tie = tieNote(decision);
  if (tie) {
    lines.push("", tie, "");
  }
  lines.push(...routingInstructions(mode, Boolean(connectedId)));
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
    "in auto mode too. Call `use_context` only once they have answered."
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
