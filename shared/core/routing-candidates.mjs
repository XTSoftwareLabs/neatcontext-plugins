// What stage one actually searches: one routing document per context.
//
// A context on disk is a profile, a knowledge folder, and a manifest. None of
// that is a shape you can match a question against, so this module flattens
// each one into a handful of named fields — what it is called, what it is for,
// what the user has called it, what is in its folder — and hands them to the
// scorer, which weighs a hit differently depending on which field it landed in.
//
// The index is built in memory and never written down. That is the decision the
// design settled on and the reason is worth keeping next to the code: several
// plugin versions share one ~/.neatcontext, so a derived file would be one more
// thing for differently-versioned readers to disagree about, go stale, and need
// repairing. Rebuilding costs a scan of material this store has already read.
//
// Rebuilding on *every* question would still be wasteful, so the index is kept
// for as long as the contexts behind it are unchanged. The fingerprint below is
// what decides that, and it is deliberately built from data the caller already
// has in hand — a context's revision and timestamps, a card's timestamp — so
// checking costs no extra reads. Only a real change pays for a rebuild.

import { declineFactor, familiarity } from "./routing.mjs";
import { buildIndex, rank, tokenize } from "./routing-search.mjs";

// The fields, in the shape the scorer weighs. Aliases are joined into one
// string rather than kept as a list because the scorer counts words, and a
// user who wrote two aliases meant both of them.
//
// `questions` and `entities` come from the bundle rather than from this
// machine, which is what makes a context findable by the same words on every
// machine it reaches. They are matched against and never displayed, so their
// size costs nothing in the prompt.
export function routingFields(context, card, files) {
  return {
    name: context.name ?? "",
    // The card wins over the manifest for the same reason the menu prefers it:
    // it is the line this machine derived, and the manifest line is the one
    // that travelled with the bundle.
    description: card?.useWhen || context.routingDescription || "",
    aliases: (card?.aliases ?? []).join(" "),
    questions: (context.routingQuestions ?? []).join(" "),
    entities: (context.routingEntities ?? []).join(" "),
    files: files.join(" ")
  };
}

// Identity of the corpus, not of its contents. Two different fingerprints mean
// something changed; the same fingerprint means nothing did, which is the only
// question the cache has to answer.
export function fingerprint(contexts, state) {
  return contexts
    .map((context) => {
      const card = state.cards[context.id];
      return [context.id, context.revision, context.updatedAt ?? "", card?.updatedAt ?? ""].join(":");
    })
    .join("|");
}

export async function routingDocuments(contexts, state, listFiles) {
  const documents = [];
  for (const context of contexts) {
    documents.push({
      id: context.id,
      fields: routingFields(context, state.cards[context.id], await listFiles(context))
    });
  }
  return documents;
}

// Holds one index for as long as it is still true.
//
// `listFiles` is passed in rather than imported so this module never has to
// know how a knowledge folder is read — and so the cache can be tested without
// a disk. It is called only when the index is actually being rebuilt, which is
// what makes the fingerprint check worth doing.
// How close the runner-up may come before the shortlist stops naming a winner.
//
// The gap between the best candidate and the next one is the only measure of
// confidence this design has, and it is worth being clear about what it is for:
// not picking better, but knowing when not to pick at all. Switching to the
// wrong context re-grounds the session and produces a confident answer out of
// another team's documents. Asking costs one line. When the two mistakes cost
// that differently, a near-tie should always become a question.
//
// A ratio rather than a difference, because scores have no fixed scale — they
// move with the size of the store and the rarity of the words in the request.
// How far ahead the leader is, relative to the field, does not.
export const CLOSE_RATIO = 0.8;

// `clear` means one candidate stands out and can be acted on. `close` means two
// or more are within a hair of each other, which is a question for the user
// rather than a decision for the model — in every mode, including auto.
export function assess(ranked) {
  if (ranked.length === 0) {
    return { verdict: "none", leaders: [] };
  }
  const leaders = ranked.filter((candidate) => candidate.score / ranked[0].score > CLOSE_RATIO);
  return { verdict: leaders.length > 1 ? "close" : "clear", leaders };
}

// --- acting on a match without being asked -----------------------------------
//
// `assess` answers "is one candidate ahead of the others", which is a question
// about the shape of the ranking. It is not the same question as "is this good
// enough to re-ground a session on", and a store of one context makes the
// difference plain: the leader is always uncontested there, so `clear` comes
// back on any query that matched a single word.
//
// So the floor below is absolute rather than relative. It asks how much of the
// request actually agreed with this context, and it lives here — beside
// `assess`, in host-neutral core — because nothing about it is specific to one
// host. Every bridge reads and writes the same `~/.neatcontext`; a rule about
// when routing may act unasked cannot be one host's private opinion.

// How many independent parts of the request have to agree.
const MIN_AGREEING_TERMS = 2;

// Where a hit has to land to count toward that floor. `FIELD_WEIGHTS` already
// rates `files` lowest because a knowledge folder's listing is incidental to
// what a context is *for*; a floor that counted filenames equally would throw
// that distinction away at the one moment it matters most, and "where is the
// deploy runbook?" would connect on two filenames and nothing else.
const INCIDENTAL_FIELDS = new Set(["files"]);

export function normalizeRoutingText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// The request split the way the user wrote it, deduplicated: one entry per
// whitespace-separated run.
//
// This is the unit the floor counts, and it has to be, because a token is not
// one. `tokenize` deliberately expands a single `checkout-api` into
// `[checkout-api, checkout, api]` and a two-character CJK request into seven
// tokens — good for recall, but counting those as agreement means one word, or
// any CJK request at all, clears a floor meant to require two.
function queryTerms(query) {
  return new Set(normalizeRoutingText(query).split(" ").filter(Boolean));
}

function agreeingTerms(candidate, query) {
  const carried = new Set(
    (candidate.matched ?? []).filter((term) => {
      const fields = candidate.matchedFields?.[term];
      return !fields || fields.some((field) => !INCIDENTAL_FIELDS.has(field));
    })
  );
  if (carried.size === 0) {
    return 0;
  }
  let agreeing = 0;
  for (const term of queryTerms(query)) {
    if (tokenize(term).some((token) => carried.has(token))) {
      agreeing += 1;
    }
  }
  return agreeing;
}

// An alias is the one routing signal the user authored by hand, at the moment
// they were correcting a wrong route, so it may stand in for the term floor.
// Only when it is specific enough to be evidence, though: a one-word alias
// found inside a longer sentence is weaker than the rule it would be skipping,
// and `api`, `pr` or `lm` are exactly the aliases people write. A one-word
// alias therefore has to be the whole request; a longer one has to appear
// contiguously in the request's tokens.
//
// One word means one word the user typed, counted the way `queryTerms` counts
// the request — not the tokens the index derived from it. `tokenize` expands
// `checkout-api` into three and `user_id` into three, and reading that as a
// multi-word alias would reopen the bypass for every ticket id, service name
// and API version anyone is likely to register.
//
// It has to survive tokenizing as two, as well. `the api` is two words the user
// typed, but `tokenize` drops the stopword and leaves one, and a one-token
// contiguous check is just "does this word appear anywhere" — the very test the
// first floor exists to prevent. `the API`, `our PR`, `how LM works` are how
// people write these aliases down, so both floors have to hold.
function wordCount(text) {
  return normalizeRoutingText(text).split(" ").filter(Boolean).length;
}

function matchesAlias(aliases, query) {
  const normalized = normalizeRoutingText(query);
  const queryTokens = tokenize(query);
  return aliases.some((alias) => {
    const aliasTokens = tokenize(alias);
    if (aliasTokens.length === 0) {
      return false;
    }
    if (wordCount(alias) < 2 || aliasTokens.length < 2) {
      return normalizeRoutingText(alias) === normalized;
    }
    return queryTokens.some((_, start) =>
      aliasTokens.every((token, offset) => queryTokens[start + offset] === token)
    );
  });
}

// Whether a leading candidate is strong enough to connect to without asking.
// `assess` has to have said `clear` first — this only decides whether the
// leader earned it.
export function isConfidentMatch(candidate, query, { aliases = [] } = {}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    return false;
  }
  if (normalizeRoutingText(candidate?.name ?? "") === normalizeRoutingText(query)) {
    return true;
  }
  return matchesAlias(aliases, query) || agreeingTerms(candidate, query) >= MIN_AGREEING_TERMS;
}

export function createRoutingIndex({ listFiles }) {
  let key = null;
  let index = null;

  return async function candidates(contexts, state, query, options = {}) {
    const next = fingerprint(contexts, state);
    if (next !== key || index === null) {
      index = buildIndex(await routingDocuments(contexts, state, listFiles));
      key = next;
    }
    const byId = new Map(contexts.map((context) => [context.id, context]));
    const now = new Date();
    const { connectedId = null, limit = 5 } = options;
    // Past refusals are applied after ranking rather than folded into the
    // index: they change on their own schedule, and rebuilding the index every
    // time someone says no would throw away the cache for a multiplier.
    //
    // Re-sorted afterwards because a discount can change the order, and the
    // shortlist's whole meaning is that it is in order.
    //
    // And cut to `limit` only after that, never before. `rank` slices on raw
    // BM25, so a candidate that wins once its decline and familiarity
    // multipliers are applied could be dropped before anything here ever saw
    // it — silently, and most damagingly for `assess`, which would then report
    // an uncontested leader because its rival had been cut.
    return rank(index, query, { ...options, limit: Number.POSITIVE_INFINITY })
      .map((result) => {
        const context = byId.get(result.id);
        return {
          id: result.id,
          name: context.name,
          score:
            result.score *
            declineFactor(state, result.id, now) *
            familiarity(state, context, { connectedId, now }),
          matched: result.matched,
          matchedFields: result.matchedFields
        };
      })
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
  };
}
