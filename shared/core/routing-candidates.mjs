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

import { declineFactor } from "./routing.mjs";
import { buildIndex, rank } from "./routing-search.mjs";

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

export function createRoutingIndex({ listFiles }) {
  let key = null;
  let index = null;

  return async function candidates(contexts, state, query, options) {
    const next = fingerprint(contexts, state);
    if (next !== key || index === null) {
      index = buildIndex(await routingDocuments(contexts, state, listFiles));
      key = next;
    }
    const names = new Map(contexts.map((context) => [context.id, context.name]));
    const now = new Date();
    // Past refusals are applied after ranking rather than folded into the
    // index: they change on their own schedule, and rebuilding the index every
    // time someone says no would throw away the cache for a multiplier.
    //
    // Re-sorted afterwards because a discount can change the order, and the
    // shortlist's whole meaning is that it is in order.
    return rank(index, query, options)
      .map((result) => ({
        id: result.id,
        name: names.get(result.id),
        score: result.score * declineFactor(state, result.id, now),
        matched: result.matched
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  };
}
