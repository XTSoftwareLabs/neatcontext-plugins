// Knowing when not to pick.
//
// Stage one produces a score, and the gap between the best candidate and the
// next one is the only measure of confidence this design has. It is not there
// to pick better — it is there to turn a near-tie into a question instead of a
// guess, because switching to the wrong context is far more expensive than
// asking which one was meant.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "claude-code", "neatcontext");
const bridgeFile = path.join(plugin, "src", "claude", "mcp-bridge.mjs");

let home;
let docs;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-confidence-test-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
});

const routing = await import("../plugins/claude-code/neatcontext/src/core/routing.mjs");
const store = await import("../plugins/claude-code/neatcontext/src/core/context-store.mjs");
const { CLOSE_RATIO, assess, isConfidentMatch, normalizeRoutingText } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs"
);

async function create(name, useWhen) {
  const { record, profileText } = await store.createContext({
    name,
    knowledgeFolder: docs,
    profile: `# ${name}\n\n## Purpose\n${useWhen}`
  });
  await routing.putCard(record.id, { useWhen, source: profileText });
  return record;
}

function bridge(sessionId = "confidence-bridge") {
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: sessionId,
      NEATCONTEXT_HOST_KEY: `host-${sessionId}`,
      CLAUDE_PID: "",
      NEATCONTEXT_HOME: home
    },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true
  });
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  });
  let nextId = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      nextId += 1;
      waiters.set(nextId, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    send,
    close: async () => {
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
  };
}

const candidate = (id, score) => ({ id, name: id, score });

const { buildIndex, rank } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-search.mjs"
);
const { routingFields } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing-candidates.mjs"
);

// The floor as the bridge actually meets it: `matched` filled by `rank` from a
// real index, rather than written by hand.
//
// Every hand-written fixture is a claim about what the index would return, and
// a wrong one hides the bug it was meant to catch — a leader carrying `user`
// but not `user_id` is a shape `rank` never produces, and the guard against
// one concept spelled twice cannot fire against it.
function confidentAgainst(description, query) {
  const context = { id: "one", name: "Ctx", routingDescription: description };
  const index = buildIndex([{ id: "one", fields: routingFields(context, null, []) }]);
  const [leader] = rank(index, query, { limit: Number.POSITIVE_INFINITY });
  return Boolean(leader) && isConfidentMatch({ ...leader, name: context.name }, query);
}

describe("assess", () => {
  it("calls a clear leader clear", () => {
    const decision = assess([candidate("winner", 10), candidate("other", 2)]);
    assert.equal(decision.verdict, "clear");
    assert.deepEqual(
      decision.leaders.map((leader) => leader.id),
      ["winner"]
    );
  });

  it("calls a near-tie close, and names everyone in it", () => {
    const decision = assess([candidate("first", 10), candidate("second", 9.5)]);
    assert.equal(decision.verdict, "close");
    assert.deepEqual(
      decision.leaders.map((leader) => leader.id),
      ["first", "second"]
    );
  });

  it("includes every candidate inside the ratio, not just two", () => {
    const decision = assess([candidate("a", 10), candidate("b", 9.5), candidate("c", 9), candidate("d", 1)]);
    assert.deepEqual(
      decision.leaders.map((leader) => leader.id),
      ["a", "b", "c"]
    );
  });

  it("treats a lone candidate as clear", () => {
    assert.equal(assess([candidate("only", 0.4)]).verdict, "clear");
  });

  it("reports nothing to decide on an empty list", () => {
    const decision = assess([]);
    assert.equal(decision.verdict, "none");
    assert.deepEqual(decision.leaders, []);
  });

  it("puts the boundary where the ratio says", () => {
    // Exactly at the ratio is not close; a shade above it is.
    assert.equal(assess([candidate("a", 10), candidate("b", 10 * CLOSE_RATIO)]).verdict, "clear");
    assert.equal(assess([candidate("a", 10), candidate("b", 10 * CLOSE_RATIO + 0.01)]).verdict, "close");
  });
});

describe("isConfidentMatch", () => {
  // `assess` answers whether one candidate is ahead of the rest. This answers
  // the other half — whether being ahead was earned — and a store of one
  // context is where the two come apart: the leader there is uncontested by
  // definition, so `clear` says nothing at all about the match.
  const hit = (term, ...fields) => [term, fields.length > 0 ? fields : ["description"]];
  const candidate = (name, ...hits) => ({
    id: name,
    name,
    score: 10,
    matched: hits.map(([term]) => term),
    matchedFields: Object.fromEntries(hits.map(([term, fields]) => [term, fields]))
  });

  it("wants two parts of the request to agree, not two tokens", () => {
    assert.equal(
      isConfidentMatch(candidate("Checkout", hit("checkout"), hit("5xx")), "checkout 5xx"),
      true
    );
  });

  it("counts one hyphenated word as the one word the user typed", () => {
    // tokenize expands `checkout-api` to run + parts on purpose, for recall.
    // Three tokens off one word is not three parts of a request agreeing.
    const leader = candidate(
      "Checkout",
      hit("checkout-api"),
      hit("checkout"),
      hit("api")
    );
    assert.equal(leader.matched.length, 3);
    assert.equal(isConfidentMatch(leader, "checkout-api"), false);
    assert.equal(isConfidentMatch(leader, "checkout-api 5xx"), false, "5xx did not match");
  });

  it("counts a CJK run the same way, rather than as one token per character", () => {
    // 订单延迟 emits its four characters and three bigrams: seven tokens, one
    // request. Left uncounted, every two-character CJK question auto-connects.
    const leader = candidate(
      "订单系统",
      hit("订"),
      hit("单"),
      hit("延"),
      hit("迟"),
      hit("订单"),
      hit("单延"),
      hit("延迟")
    );
    assert.equal(isConfidentMatch(leader, "订单延迟"), false);
    assert.equal(isConfidentMatch(leader, "订单延迟 排查"), false, "排查 did not match");
  });

  it("leaves a no-space script unable to reach the floor, deliberately", () => {
    // A script written without spaces is one part of the request however long
    // it runs, so it can supply at most one pairing. Auto-connect is therefore
    // out of reach for these requests until this can segment them, and the
    // escape hatches below are the whole of what is left. This is a decision,
    // not an oversight: the routing menu still answers, which is what every
    // user gets today.
    const leader = candidate(
      "订单系统",
      hit("订单"),
      hit("延迟"),
      hit("排查"),
      hit("步骤"),
      hit("订"),
      hit("单")
    );
    assert.equal(isConfidentMatch(leader, "订单延迟排查步骤"), false);

    // Naming the context still works, and so does an alias the user wrote,
    // when it is the whole request.
    assert.equal(isConfidentMatch(candidate("订单排查"), "订单排查"), true);
    assert.equal(
      isConfidentMatch(leader, "订单排查", { aliases: ["订单排查"] }),
      true
    );
  });

  it("does not black out Korean, which is written with spaces", () => {
    // The limitation above is about scripts with no spaces, not about CJK: a
    // Korean request separates its eojeol and goes through the ordinary path.
    const leader = candidate("주문 지연", hit("주문"), hit("지연"));
    assert.equal(isConfidentMatch(leader, "주문 지연"), true);
  });

  it("does not let one concept spelled two ways count as two", () => {
    // `user_id` tokenizes to [user_id, user, id] and `user?` to [user], so both
    // words agree on one concept. Two parts of the request, one thing agreed
    // on — which is one piece of evidence, not two.
    //
    // Fixtured as `rank` actually fills `matched`, which is the whole reason
    // this bites: a description containing `user_id` indexes every one of
    // [user_id, user, id], so all three come back and the pairing had three
    // separate things to spend two words on. Handing the leader `user` alone
    // was the one shape in which the guard could never fire.
    assert.equal(
      isConfidentMatch(
        candidate("Users", hit("user_id"), hit("user"), hit("id")),
        "what does user_id mean for a user?"
      ),
      false
    );
    assert.equal(
      isConfidentMatch(
        candidate("Checkout API", hit("api"), hit("checkout-api"), hit("checkout")),
        "is the api part of checkout-api?"
      ),
      false
    );
    assert.equal(
      isConfidentMatch(
        candidate("Docker", hit("docker"), hit("docker-compose"), hit("compose")),
        "docker in docker-compose"
      ),
      false
    );
    // Two compounds sharing their only carried token is still one concept.
    assert.equal(
      isConfidentMatch(candidate("Docker", hit("docker")), "docker-compose docker-swarm"),
      false
    );
    // Two spellings that are genuinely two things still count as two.
    assert.equal(
      isConfidentMatch(candidate("Users", hit("user"), hit("users")), "user users"),
      true
    );
  });

  it("still counts a second word that agreed on something of its own", () => {
    // now sits. "How we run services under `docker-compose`" indexes
    // [run, docker, docker-compose, compose]; the request "how do I run docker
    // in docker-compose" names the compound twice — collapsed to one — but also
    // agrees on `run`, which the description carries independently of it. Two
    // parts of the request, two things agreed on, and the floor is met.
    //
    // That is the rule working, not escaping: `run` is a word in the request
    // that a word in the description matched. Reading it as a false positive
    // would mean the floor had to know which agreements are interesting, which
    // is a stopword list with no principled place to stop.
    const leader = candidate(
      "Docker",
      hit("run"),
      hit("docker"),
      hit("docker-compose"),
      hit("compose")
    );
    assert.equal(isConfidentMatch(leader, "how do I run docker in docker-compose"), true);
    // Take that second agreement away and the compound is on its own again.
    assert.equal(isConfidentMatch(leader, "docker in docker-compose"), false);
  });

  it("holds against `matched` as a real index fills it", () => {
    // The same rule with no fixture in the way. Each row builds an index from a
    // description, ranks the request against it, and hands `isConfidentMatch`
    // whatever `rank` produced — which is the only version of this that proves
    // anything about the bridge.
    assert.equal(
      confidentAgainst(
        "How the `user_id` column is populated.",
        "what does user_id mean for a user?"
      ),
      false
    );
    assert.equal(
      confidentAgainst(
        "Everything about the `checkout-api` service.",
        "is the api part of checkout-api?"
      ),
      false
    );
    assert.equal(
      confidentAgainst("How we run services under `docker-compose`.", "docker in docker-compose"),
      false
    );
    assert.equal(confidentAgainst("Notes about the user table.", "what does user mean"), false);

    // The controls: a request that agreed on two separate things still routes.
    assert.equal(
      confidentAgainst("checkout 5xx incidents and their causes.", "checkout 5xx"),
      true
    );
    // Including the case above once the request supplies a second agreement of
    // its own — `run` is carried by the description independently of the
    // compound, so this is two, and it is meant to be.
    assert.equal(
      confidentAgainst(
        "How we run services under `docker-compose`.",
        "how do I run docker in docker-compose"
      ),
      true
    );
  });

  it("pairs the same way whichever order the words arrive in", () => {
    // `alpha-beta` can be spent on either token, so a first-come pairing counts
    // this as two one way round and one the other. Rewording a sentence must
    // not change where it routes.
    const leader = candidate("Alpha", hit("alpha"), hit("beta"));
    assert.equal(isConfidentMatch(leader, "alpha alpha-beta"), true);
    assert.equal(isConfidentMatch(leader, "alpha-beta alpha"), true);

    const single = candidate("Alpha", hit("alpha"));
    assert.equal(isConfidentMatch(single, "alpha alpha-beta"), false);
    assert.equal(isConfidentMatch(single, "alpha-beta alpha"), false);
  });

  it("does not let two filenames stand in for what a context is for", () => {
    const leader = candidate("Payments", hit("deploy", "files"), hit("runbook", "files"));
    assert.equal(isConfidentMatch(leader, "where is the deploy runbook?"), false);
  });

  it("counts a filename hit that also landed somewhere that means something", () => {
    const leader = candidate(
      "Payments",
      hit("deploy", "files", "description"),
      hit("runbook", "files")
    );
    assert.equal(isConfidentMatch(leader, "deploy runbook rollback"), false);
    assert.equal(
      isConfidentMatch(candidate("Payments", hit("deploy", "files", "description"), hit("rollback")), "deploy rollback"),
      true
    );
  });

  it("takes a candidate whose fields were never recorded at face value", () => {
    // Older callers hand back `matched` alone. Silently scoring those at zero
    // would turn a missing field map into a routing outage.
    assert.equal(
      isConfidentMatch({ name: "Checkout", matched: ["checkout", "5xx"] }, "checkout 5xx"),
      true
    );
  });

  it("connects on the context's own name", () => {
    assert.equal(isConfidentMatch(candidate("Checkout incident"), "  Checkout   Incident "), true);
  });

  it("connects on an alias the user wrote, when it is specific enough to be one", () => {
    const leader = candidate("Windows notes", hit("windows"));
    assert.equal(
      isConfidentMatch(leader, "how does LM coordination work in Windows ServiceManager?", {
        aliases: ["LM coordination"]
      }),
      true
    );
  });

  it("refuses a one-word alias found inside an ordinary sentence", () => {
    // `api`, `pr`, `lm` are exactly the aliases people write, and derived cards
    // generate them too. Matching one inside a sentence is weaker evidence than
    // the floor it would be skipping.
    const leader = candidate("Windows notes", hit("windows"));
    assert.equal(
      isConfidentMatch(leader, "how do I install Docker on Windows?", { aliases: ["windows"] }),
      false
    );
    // It is still the user's word for this context when it is the whole ask.
    assert.equal(isConfidentMatch(leader, "Windows", { aliases: ["windows"] }), true);
  });

  it("refuses a punctuated one-word alias found inside an ordinary sentence", () => {
    // `tokenize` splits `checkout-api` into three, so counting tokens would
    // read this as a multi-word alias and let it match from inside a sentence —
    // reopening the bypass for every ticket id, service name and API version
    // anyone registers. One word means one word the user typed.
    const leader = candidate("Checkout API", hit("checkout-api"));
    for (const alias of ["checkout-api", "user_id", "api-v2", "INC-1001"]) {
      assert.equal(
        isConfidentMatch(leader, `why is ${alias} throwing 5xx on staging?`, { aliases: [alias] }),
        false,
        alias
      );
      assert.equal(isConfidentMatch(leader, alias, { aliases: [alias] }), true, alias);
    }
  });

  it("refuses a multi-word alias that tokenizes down to one word", () => {
    // `the api` is two words, but `tokenize` drops the stopword and leaves one,
    // and a one-token contiguous check is just "does this word appear anywhere".
    // `the API`, `our PR`, `how LM works` are how people write these down.
    const leader = candidate("Payments API", hit("api"));
    for (const [alias, query] of [
      ["the api", "why is the api throwing 5xx today?"],
      ["our api", "why is the api throwing 5xx today?"],
      ["how api", "why is the api throwing 5xx today?"],
      ["our pr", "why was our pr merged so fast today?"]
    ]) {
      assert.equal(isConfidentMatch(leader, query, { aliases: [alias] }), false, alias);
    }
    // Two words that both survive still route from inside a sentence.
    assert.equal(
      isConfidentMatch(leader, "why is the payments api throwing 5xx today?", {
        aliases: ["payments api"]
      }),
      true
    );
  });

  it("ignores an alias with nothing matchable in it", () => {
    const leader = candidate("Notes", hit("notes"));
    assert.equal(isConfidentMatch(leader, "a note about x", { aliases: ["!!", "-"] }), false);
  });

  it("refuses when there is no request to match against", () => {
    const leader = candidate("Checkout", hit("checkout"), hit("5xx"));
    assert.equal(isConfidentMatch(leader, "   "), false);
    assert.equal(isConfidentMatch(leader, undefined), false);
  });

  it("refuses a candidate that matched nothing", () => {
    assert.equal(isConfidentMatch({ name: "Checkout" }, "checkout 5xx"), false);
  });

  it("normalizes the way the rest of routing does", () => {
    assert.equal(normalizeRoutingText("  Checkout   API  "), "checkout api");
  });
});

describe("the default mode", () => {
  it("is auto, because asking is now the route's decision and not the dial's", async () => {
    // Auto only became safe once a near-tie asks on its own. Before that, "ask
    // first" was the only safety net there was and had to be on for everybody.
    const state = await routing.readRouting();
    assert.equal(routing.DEFAULT_MODE, "auto");
    assert.equal(routing.resolveMode(state, "session-with-no-preference"), "auto");
  });

  it("still lets a session choose ask or manual for itself", async () => {
    await routing.setMode("ask", { id: "picky-session" });
    const state = await routing.readRouting();
    assert.equal(routing.resolveMode(state, "picky-session"), "ask");
    assert.equal(routing.resolveMode(state, "another-session"), "auto");
  });
});

describe("renderShortlist with a decision", () => {
  const entries = [
    { id: "a", name: "Codex plugin", useWhen: "packaging", aliases: [], score: 10 },
    { id: "b", name: "Kimi plugin", useWhen: "packaging", aliases: [], score: 9.8 }
  ];

  it("asks rather than picks when two match equally", () => {
    const text = routing.renderShortlist(entries, { mode: "auto", decision: assess(entries) });
    assert.match(text, /\*\*Codex plugin\*\* and \*\*Kimi plugin\*\* match the request about equally well/);
    assert.match(text, /ask which/);
  });

  it("overrides auto explicitly, since auto is where the mistake would go unseen", () => {
    const text = routing.renderShortlist(entries, { mode: "auto", decision: assess(entries) });
    assert.match(text, /in auto mode too/);
    // Worded for both situations: a near-tie is a question whether the session
    // would be switching contexts or connecting its first one.
    assert.match(text, /Call `use_context` only once they have answered/);
  });

  it("says nothing about ties when there is a clear leader", () => {
    const clear = [
      { id: "a", name: "Codex plugin", useWhen: "packaging", aliases: [], score: 10 },
      { id: "b", name: "Kimi plugin", useWhen: "packaging", aliases: [], score: 2 }
    ];
    const text = routing.renderShortlist(clear, { mode: "auto", decision: assess(clear) });
    assert.ok(!text.includes("about equally well"));
  });

  it("renders without a decision at all", () => {
    // The renderer keeps working for callers that have no scores to hand.
    assert.match(routing.renderShortlist(entries, { mode: "ask" }), /Contexts that match/);
  });
});

describe("renderMenu with a decision", () => {
  // The full menu is what goes out below SHORTLIST_MIN_CONTEXTS, which is where
  // most machines live. A tie the plugin refused to act on has to reach the
  // model here too — otherwise the plugin declines, explains nothing, and the
  // model picks one of the two anyway.
  const entries = [
    { id: "a", name: "Codex plugin", useWhen: "packaging", aliases: [] },
    { id: "b", name: "Kimi plugin", useWhen: "packaging", aliases: [] }
  ];
  const scored = entries.map((entry, index) => ({ ...entry, score: index === 0 ? 10 : 9.8 }));

  it("carries the near-tie into the full menu", () => {
    const text = routing.renderMenu(entries, { mode: "auto", decision: assess(scored) });
    assert.match(text, /\*\*Codex plugin\*\* and \*\*Kimi plugin\*\* match the request about equally well/);
    assert.match(text, /in auto mode too/);
  });

  it("says nothing about ties when there is a clear leader, or no decision", () => {
    const clear = assess([{ ...entries[0], score: 10 }, { ...entries[1], score: 2 }]);
    assert.ok(!routing.renderMenu(entries, { mode: "auto", decision: clear }).includes("equally well"));
    assert.ok(!routing.renderMenu(entries, { mode: "auto" }).includes("equally well"));
  });

  // The note is its own paragraph. Run into the guidance that follows it, the
  // two read as one sentence about the wrong thing.
  it("stands the near-tie note apart from the guidance around it", () => {
    const decision = assess(scored);
    for (const text of [
      routing.renderMenu(entries, { mode: "auto", decision }),
      routing.renderShortlist(entries, { mode: "auto", decision })
    ]) {
      const lines = text.split("\n");
      const at = lines.findIndex((line) => line.includes("match the request about equally well"));
      assert.ok(at > 0, "the note is there to be spaced");
      assert.equal(lines[at - 1], "");
      assert.equal(lines[at + 1], "");
    }
  });
});

describe("the bridge decides from real scores", () => {
  // Two contexts described identically: nothing but the name separates them,
  // so a request about what they share is a genuine coin flip.
  async function seedTwins() {
    await create("Codex plugin packaging", "plugin packaging, manifests and marketplace steps");
    await create("Kimi plugin packaging", "plugin packaging, manifests and marketplace steps");
    await create("INC-1001 checkout", "checkout-api 5xx from pgbouncer pool exhaustion");
    await create("Queue lag", "order-events partition lag and consumer rebalancing");
    await create("Refunds", "refunds and chargebacks");
    await create("Docker container", "Ubuntu container with SSH");
    await create("Session drift", "MCP bridge session and thread drift");
    await create("Evidence", "conversation evidence and transcript adapters");
    await create("Marketplace config", "switching the marketplace source");
  }

  async function notesFor(query) {
    const client = bridge();
    try {
      await client.send("initialize", {});
      const response = await client.send("tools/call", {
        name: "get_context",
        arguments: { query }
      });
      return response.result.content[0].text;
    } finally {
      await client.close();
    }
  }

  it("asks which one when the request cannot separate two contexts", async () => {
    await seedTwins();
    const notes = await notesFor("manifests and marketplace steps");
    assert.match(notes, /match the request about equally well/);
    assert.match(notes, /Codex plugin packaging/);
    assert.match(notes, /Kimi plugin packaging/);
  });

  it("names a winner when the request does separate them", async () => {
    await seedTwins();
    const notes = await notesFor("pgbouncer pool exhaustion on checkout-api");
    assert.match(notes, /INC-1001 checkout/);
    assert.ok(!notes.includes("match the request about equally well"));
  });
});
