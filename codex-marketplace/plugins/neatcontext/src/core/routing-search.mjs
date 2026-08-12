// Stage one of routing: narrowing every context down to a handful, by counting.
//
// No process in this plugin has a model, so nothing here understands a
// sentence. What it does is count how many of a question's words appear in a
// context's routing material, weighted so that a rare word is worth more than a
// common one — `INC-1001` is nearly proof on its own, "service" is noise. That
// is enough to take a list of every context down to a few candidates, which is
// all this stage has to do: the session's model still makes the actual choice,
// and it makes it from the shortlist rather than from the whole menu.
//
// BM25F is the scoring function, and the F is the part that matters here. A hit
// in an alias the user typed after a wrong route is worth more than a hit in a
// filename, so every field carries its own weight. Saturation is applied once
// across all the fields rather than per field, which is what stops the same
// word repeated inside one long field from outscoring a word that shows up in
// several different ones.
//
// Nothing in this file touches the disk or keeps state between calls. A caller
// builds an index, holds it for as long as the contexts are unchanged, and
// throws it away. That is deliberate: a derived file shared by several plugin
// versions is exactly the kind of state this store has been bitten by before.

const K1 = 1.2;
const B = 0.75;

// What a hit is worth, by where it lands. Aliases lead because a user wrote
// them by hand, at the one moment they were correcting a wrong route; filenames
// trail because they are incidental to what a context is about.
export const FIELD_WEIGHTS = {
  aliases: 5,
  entities: 4,
  name: 3,
  questions: 2,
  description: 1.5,
  files: 1
};

const DEFAULT_FIELD_WEIGHT = 1;

// Words too common to carry meaning. Inverse document frequency already
// discounts them, but only against this corpus: with forty contexts, a stray
// "the" in one of them still scores something. Dropping them outright is
// cheaper than letting the arithmetic sort it out, and it keeps the matched
// terms reported below worth reading.
const STOPWORDS = new Set([
  "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did",
  "do", "does", "for", "from", "had", "has", "have", "how", "if", "in",
  "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "that",
  "the", "their", "them", "then", "there", "they", "this", "to", "was", "we",
  "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "you", "your"
]);

// Two alternatives, because the two scripts need opposite treatment.
//
// A Latin run keeps its internal punctuation so that `inc-1001`, `checkout-api`
// and `default_pool_size` survive as single rare tokens — those are the words
// that decide a route, and splitting them would throw away exactly the rarity
// that makes them useful.
//
// CJK has no spaces to split on. Each run therefore contributes its individual
// characters and its adjacent character pairs, which is the standard substitute
// for a word segmenter and is enough for matching.
const TOKEN =
  /([a-z0-9]+(?:[-_./][a-z0-9]+)*)|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/gu;

const LATIN_PARTS = /[-_./]/;

export function tokenize(text) {
  if (typeof text !== "string") {
    return [];
  }
  const tokens = [];
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    if (match[1] === undefined) {
      addCjk(tokens, match[2]);
    } else {
      addLatin(tokens, match[1]);
    }
  }
  return tokens;
}

// The whole run, plus its parts when it has any. Both are wanted: the run is
// what makes `inc-1001` rare, and the parts are what let someone who typed
// "INC 1001" still find it.
function addLatin(tokens, run) {
  keep(tokens, run);
  const parts = run.split(LATIN_PARTS);
  if (parts.length > 1) {
    for (const part of parts) {
      keep(tokens, part);
    }
  }
}

function addCjk(tokens, run) {
  const characters = [...run];
  for (let index = 0; index < characters.length; index += 1) {
    tokens.push(characters[index]);
    if (index + 1 < characters.length) {
      tokens.push(characters[index] + characters[index + 1]);
    }
  }
}

// Single Latin letters are noise; single CJK characters are words, which is why
// they never come through here.
function keep(tokens, token) {
  if (token.length > 1 && !STOPWORDS.has(token)) {
    tokens.push(token);
  }
}

// `entries` are `{ id, fields }`, where `fields` maps a field name to its text.
// A field the caller does not supply simply does not exist for that entry, and
// an unknown field name scores at the default weight rather than being dropped
// — a caller adding a field should get a working search, not a silent zero.
export function buildIndex(entries) {
  const documents = new Map();
  const postings = new Map();
  const totals = new Map();
  const counts = new Map();

  for (const entry of entries) {
    const lengths = new Map();
    for (const [field, text] of Object.entries(entry.fields ?? {})) {
      const tokens = tokenize(text);
      lengths.set(field, tokens.length);
      totals.set(field, (totals.get(field) ?? 0) + tokens.length);
      counts.set(field, (counts.get(field) ?? 0) + 1);
      for (const token of tokens) {
        addPosting(postings, token, entry.id, field);
      }
    }
    documents.set(entry.id, lengths);
  }

  const averages = new Map();
  for (const [field, total] of totals) {
    averages.set(field, total / counts.get(field));
  }

  return { documents, postings, averages, size: documents.size };
}

function addPosting(postings, token, id, field) {
  let byDocument = postings.get(token);
  if (byDocument === undefined) {
    byDocument = new Map();
    postings.set(token, byDocument);
  }
  let byField = byDocument.get(id);
  if (byField === undefined) {
    byField = new Map();
    byDocument.set(id, byField);
  }
  byField.set(field, (byField.get(field) ?? 0) + 1);
}

// Ranked candidates, best first, each with the query terms that put it there.
// Those terms are the "why it matched" the session's model gets to read, and
// they are the reason a caller can explain a route instead of asserting one.
//
// `matchedFields` says *where* each of those terms landed, which is the same
// distinction `FIELD_WEIGHTS` already makes and for the same reason: a hit in
// an alias the user wrote is evidence, and a hit in a filename picked up from a
// folder listing is a coincidence. Scoring weighs them apart; a caller deciding
// whether a match is strong enough to act on unasked needs to as well, and it
// cannot recover the field from the term alone.
export function rank(index, query, { limit = 5 } = {}) {
  const terms = [...new Set(tokenize(query))];
  const scores = new Map();
  const matches = new Map();
  const landed = new Map();

  for (const term of terms) {
    const byDocument = index.postings.get(term);
    if (byDocument === undefined) {
      continue;
    }
    // Rarity, the ordinary way: a term in one context out of forty says far
    // more than one that is in thirty of them.
    const idf = Math.log(1 + (index.size - byDocument.size + 0.5) / (byDocument.size + 0.5));
    for (const [id, byField] of byDocument) {
      let weighted = 0;
      for (const [field, count] of byField) {
        const length = index.documents.get(id).get(field);
        const normalized = 1 - B + (B * length) / index.averages.get(field);
        weighted += ((FIELD_WEIGHTS[field] ?? DEFAULT_FIELD_WEIGHT) * count) / normalized;
      }
      scores.set(id, (scores.get(id) ?? 0) + (idf * weighted) / (K1 + weighted));
      matches.set(id, [...(matches.get(id) ?? []), term]);
      const byTerm = landed.get(id) ?? new Map();
      byTerm.set(term, [...byField.keys()]);
      landed.set(id, byTerm);
    }
  }

  return [...scores]
    .map(([id, score]) => ({
      id,
      score,
      matched: matches.get(id),
      matchedFields: Object.fromEntries(landed.get(id))
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}
