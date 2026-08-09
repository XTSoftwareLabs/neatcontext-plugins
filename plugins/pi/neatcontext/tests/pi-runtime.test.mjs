// The pi runtime, driven the way the extension drives it: in-process, with a
// bound session id and no MCP anywhere.
//
// These run against a temporary NEATCONTEXT_HOME, so nothing here
// touches a real ~/.neatcontext.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

let home;
let docs;
let runtime;
let session;
let store;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-pi-test-"));
  process.env.NEATCONTEXT_HOME = home;

  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");

  // Imported after the env var is set, so the very first call resolves paths
  // inside the temporary home.
  runtime = await import("../src/pi/runtime.mjs");
  session = await import("../src/pi/session.mjs");
  store = await import("../src/core/context-store.mjs");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  session.bindPiSessionId("pi-test-session");
});

const PROFILE = "# Orders\n\n## Purpose\n\nOrder pipeline.\n";

function createOrders(name = "Orders") {
  return runtime.createContext({
    name,
    knowledgeFolder: docs,
    profile: PROFILE,
    useWhen: "order-events lag, order-projection workers, partition skew"
  });
}

describe("session identity", () => {
  it("accepts the ids pi actually issues and rejects unusable ones", () => {
    assert.equal(session.normalizePiSessionId("0199f0aa-7b3e-7000-8000-abc"), "0199f0aa-7b3e-7000-8000-abc");
    assert.equal(session.normalizePiSessionId("  pi.session_1  "), "pi.session_1");
    assert.equal(session.normalizePiSessionId(""), null);
    assert.equal(session.normalizePiSessionId("../escape"), null);
    assert.equal(session.normalizePiSessionId("-leading"), null);
    assert.equal(session.normalizePiSessionId(undefined), null);
  });

  it("keeps the previous binding when pi offers an unusable id", () => {
    session.bindPiSessionId("good-session");
    assert.equal(session.bindPiSessionId("../bad"), null);
    assert.equal(session.piSessionId(), "good-session");
    assert.equal(session.isPiSessionBound(), true);
  });

  it("gives each pi session its own connected context", async () => {
    await createOrders();
    session.bindPiSessionId("session-one");
    await runtime.commandUse("Orders");
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);

    session.bindPiSessionId("session-two");
    assert.match(await runtime.commandStatus(), /No context is connected yet/);
  });
});

describe("local Contexts", () => {
  it("creates, lists, connects, and grounds", async () => {
    const created = await createOrders();
    assert.match(created, /Created the "Orders" context/);
    assert.match(created, /Routes here for:  order-events lag/);

    const list = await runtime.commandList();
    assert.match(list, /Contexts:\n {2}1\. Orders/);

    assert.match(await runtime.commandUse("Orders"), /Connected the "Orders" context/);

    const context = await runtime.getContext();
    assert.match(context, /NeatContext — connected context: Orders/);
    assert.match(context, /runbook\.md/);
    // The plugin's own notes ride on every get_context, so a mid-session mode
    // change reaches the model without a restart.
    assert.match(context, /## Connecting a context, in pi/);
  });

  it("says nothing is connected in pi's own terms", async () => {
    const context = await runtime.getContext();
    assert.match(context, /No NeatContext Context is connected to this session/);
    assert.match(context, /\/neatcontext-use/);
    // Never Claude's or Codex's command syntax.
    assert.doesNotMatch(context, /\/neatcontext:/);
    assert.doesNotMatch(context, /\$neatcontext:/);
  });

  // With contexts to route to, a slash command is the wrong lead: it answers
  // "what now?" before the menu below it gets a turn, and the model acts on it.
  it("tells an ungrounded session to connect a context itself", async () => {
    await createOrders();
    const context = await runtime.getContext("order fulfillment");
    assert.match(context, /Connect the one this request belongs to with `use_context`/);
    assert.match(context, /do not ask the user to run a command/);
  });

  // Manual mode publishes no menu, so there is nothing for the session to
  // connect from and the command really is the only way forward.
  it("falls back to the commands when routing is off", async () => {
    await createOrders();
    await runtime.commandMode("manual");
    const context = await runtime.getContext("order fulfillment");
    assert.match(context, /Connect one with `\/neatcontext-use`/);
    assert.doesNotMatch(context, /## Contexts available on this machine/);
  });

  it("refuses a knowledge folder that is not there", async () => {
    const result = await runtime.createContext({
      name: "Ghost",
      knowledgeFolder: path.join(home, "nope"),
      profile: PROFILE
    });
    assert.match(result, /No folder at/);
  });

  it("disconnects, and reports nothing left to disconnect", async () => {
    await createOrders();
    await runtime.commandUse("Orders");
    assert.match(await runtime.commandDisconnect(), /Disconnected the "Orders" context/);
    assert.match(await runtime.commandDisconnect(), /No context is connected to this session/);
  });

  it("reports and clears an unavailable legacy selection", async () => {
    const selectionFile = path.join(home, "plugin-sessions", "pi-test-session.json");
    await mkdir(path.dirname(selectionFile), { recursive: true });
    await writeFile(
      selectionFile,
      `${JSON.stringify({ contextId: "unavailable:old", contextName: "Old selection" })}\n`
    );
    assert.match(await runtime.commandStatus(), /Old selection.*not available/s);
    assert.match(await runtime.commandStatus(), /No context is connected yet/);
    await assert.rejects(readFile(selectionFile, "utf8"), { code: "ENOENT" });
  });

  it("deletes only after confirmation", async () => {
    await createOrders();
    const plan = await runtime.deleteContext("Orders");
    assert.equal(plan.done, false);
    assert.equal(plan.target.name, "Orders");
    // A folder the user brought is theirs, and delete has to say it stays.
    assert.match(plan.text, /will NOT be touched/);

    const done = await runtime.deleteContext("Orders", { confirm: true });
    assert.equal(done.done, true);
    assert.match(done.text, /Deleted the "Orders" context/);
    assert.match(await runtime.commandList(), /\(none — save this conversation/);
  });
});

describe("routing", () => {
  it("reports and changes the mode for this session", async () => {
    assert.match(await runtime.commandMode(), /Context routing is auto \(the default\)/);
    assert.match(await runtime.commandMode("ask"), /now ask for this session/);
    assert.match(await runtime.commandMode(), /Context routing is ask \(this session\)/);
    assert.match(await runtime.commandMode("sideways"), /is not a mode/);
  });

  // pi cannot remove a registered tool mid-session, so manual mode is a refusal
  // rather than an absent tool. The contract the user sees is unchanged.
  it("refuses to switch in manual mode instead of hiding the tool", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");
    await runtime.commandMode("manual");

    const refused = await runtime.useContext({ context: "Billing", requested: false });
    assert.match(refused, /routing is off \(manual mode\)/);
    assert.match(refused, /\/neatcontext-use Billing/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);
  });

  it("asks before switching in ask mode, then switches when the user agreed", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");
    // Set explicitly rather than assumed, so this keeps testing ask mode
    // whatever the default becomes.
    await runtime.commandMode("ask");

    assert.match(await runtime.useContext({ context: "Billing" }), /ask mode, so nothing has changed/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);

    const switched = await runtime.useContext({
      context: "Billing",
      requested: true,
      alias: "invoices"
    });
    assert.match(switched, /Switched this session to "Billing"/);
    assert.match(switched, /"invoices" will route here from now on/);
    assert.match(await runtime.commandStatus(), /Connected context: Billing/);
  });

  it("remembers a declined switch for the rest of the session", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");
    await runtime.commandMode("auto");

    assert.match(
      await runtime.useContext({ context: "Billing", declined: true }),
      /will not be suggested again this session/
    );
    assert.match(
      await runtime.useContext({ context: "Billing" }),
      /already declined switching to "Billing"/
    );
  });

  it("previews a context without connecting it", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");

    const preview = await runtime.previewContext({ context: "Billing" });
    assert.match(preview, /# Billing/);
    assert.match(preview, /runbook\.md/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);
  });

  it("records a routing description and an alias", async () => {
    await createOrders();
    const described = await runtime.describeContext({
      context: "Orders",
      useWhen: "order-projection partition lag",
      alias: "the order thing"
    });
    assert.match(described, /now routes for: order-projection partition lag/);
    assert.match(described, /"the order thing" now routes to "Orders"/);
    assert.match(await runtime.getContext(), /order-projection partition lag/);
  });

  it("puts the routing menu and connection rule into every turn's instructions", async () => {
    await createOrders();
    const instructions = await runtime.sessionInstructions();
    assert.match(instructions, /^# NeatContext/);
    assert.match(instructions, /No NeatContext Context is connected to this session right now/);
    assert.match(instructions, /## Contexts available on this machine/);
    assert.match(instructions, /- \*\*Orders\*\*/);
    assert.match(instructions, /## Connecting a context, in pi/);
  });

  it("drops the menu in manual mode", async () => {
    await createOrders();
    await runtime.commandMode("manual");
    const instructions = await runtime.sessionInstructions();
    assert.doesNotMatch(instructions, /## Contexts available on this machine/);
    assert.match(instructions, /## Connecting a context, in pi/);
  });
});

describe("save", () => {
  const knowledge = [{ path: "session-summary.md", content: "# Summary\n\nPartition 17 lagged.\n" }];

  it("plans a create when nothing matches the name", async () => {
    assert.match(await runtime.saveContext({ name: "Queue lag" }), /Save action: create/);
    assert.match(await runtime.saveContext({}), /Save action: create/);
  });

  it("creates from a capture passed as arguments", async () => {
    const saved = await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    assert.match(saved, /Saved context: Queue lag/);
    // Nothing was connected to this session, so the save is also the connection.
    assert.match(saved, /Connected context: Queue lag/);
    assert.match(await runtime.commandStatus(), /Connected context: Queue lag/);
    assert.match(await runtime.commandList(), /Queue lag/);
  });

  it("connects a session that had no context, and leaves a connected one alone", async () => {
    await createOrders();
    const first = await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    assert.match(first, /Connected context: Queue lag/);

    // Save As, from a session that is already grounded: the new context is
    // written, and the session stays where it was.
    await runtime.commandUse("Orders");
    const second = await runtime.saveContext({
      name: "Queue lag II",
      profile: "# Queue lag II\n\n## Purpose\n\nMore partition skew.\n",
      routingDescription: "order-events partition lag, second pass",
      knowledge
    });
    assert.match(second, /Connect it with: \/neatcontext-use Queue lag II/);
    assert.match(second, /stays connected to "Orders"/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);
  });

  it("exports a saved Context and keeps the neutral manifest", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    const destination = path.join(home, "exports");
    const exported = await runtime.exportContext({
      context: "Queue lag",
      destination
    });
    assert.match(exported, /Exported the "Queue lag" context/);
    assert.match(exported, /the export is a copy/);
    const bundle = /Bundle folder:\s+(.+)/.exec(exported)[1];
    const manifest = JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8"));
    assert.equal(manifest.schema, 2);
    assert.equal("kind" in manifest, false);
  });

  it("refuses to export a Context whose knowledge is externally owned", async () => {
    await createOrders();
    const exported = await runtime.exportContext({
      context: "Orders",
      destination: path.join(home, "exports")
    });
    assert.match(exported, /links a knowledge folder this plugin does not own/);
  });

  it("plans an update with the existing profile and knowledge inline", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });

    const plan = await runtime.saveContext({ name: "Queue lag" });
    assert.match(plan, /Save action: update/);
    assert.match(plan, /targetId: context:queue-lag/);
    assert.match(plan, /baseHash: [0-9a-f]{8}/);
    // The merge inputs come back with the plan, so drafting is one round trip.
    assert.match(plan, /## Existing domain profile/);
    assert.match(plan, /Partition skew/);
    assert.match(plan, /### session-summary\.md/);
    assert.match(plan, /Partition 17 lagged/);
  });

  it("previews an update, and only applies it on confirm", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    const plan = await runtime.saveContext({ name: "Queue lag" });
    const targetId = /targetId: (\S+)/.exec(plan)[1];
    const baseHash = /baseHash: (\S+)/.exec(plan)[1];

    const capture = {
      targetId,
      baseHash,
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew, now with a fix.\n",
      routingDescription: "order-events partition lag",
      knowledge: [
        ...knowledge,
        { path: "decisions.md", content: "# Decisions\n\nSplit the partition key.\n" }
      ]
    };

    const preview = await runtime.saveContext(capture);
    assert.match(preview, /Update the "Queue lag" context\?/);
    assert.match(preview, /Add: decisions\.md/);
    assert.match(preview, /`confirm: true`/);

    const applied = await runtime.saveContext({ ...capture, confirm: true });
    assert.match(applied, /Updated context: Queue lag/);
    assert.match(await runtime.saveContext({ name: "Queue lag" }), /Split the partition key/);
  });

  // Save resolves names more strictly than use_context on purpose: partial
  // matching would turn "save as" into a surprising mutation.
  it("asks which context a near-miss name meant instead of creating one", async () => {
    await createOrders("Queue lag");
    const plan = await runtime.saveContext({ name: "Queue lags" });
    assert.match(plan, /Save action: choose/);
    assert.match(plan, /Queue lag/);
  });

  it("updates the context this session is already on when given no name", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    await runtime.commandUse("Queue lag");
    assert.match(await runtime.saveContext({}), /Save action: update/);
  });
});

// pi is the one host whose tool list is fixed for the session, so its
// extensions are reached through the `use_extension` proxy and named in
// get_context rather than registered per context. What has to hold is the same
// as everywhere else: a declaration alone runs nothing, only the connected
// context's tools are callable, and the grounding survives all of it.
describe("extensions", () => {
  const fakeServer = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "tests",
    "fake-extension-server.mjs"
  );

  async function bind(value) {
    await writeFile(
      path.join(home, "extensions.json"),
      `${JSON.stringify({ schema: 1, extensions: { pagerduty: value } }, null, 2)}\n`
    );
  }

  async function declaredOrders() {
    await createOrders();
    await runtime.commandUse("Orders");
    return runtime.declareExtension({
      id: "pagerduty",
      capability: "Read incidents.",
      tools: ["get_incident"]
    });
  }

  it("declares without connecting anything", async () => {
    const declared = await declaredOrders();
    assert.match(declared, /now expects the "pagerduty" extension/);
    assert.match(declared, /That is a declaration, not a connection/);
    assert.match(await runtime.commandExtensions(""), /not configured on this machine/);
    // Nothing to call, and the model is told why rather than left guessing.
    assert.match(
      await runtime.useExtension({ tool: "pagerduty__get_incident" }),
      /none of them are available right now/
    );
    assert.match(await runtime.getContext(), /\(not configured on this machine\)/);
  });

  it("calls a bound extension and names the tools in get_context", async () => {
    await declaredOrders();
    await bind({ command: process.execPath, args: [fakeServer] });

    const grounding = await runtime.getContext();
    assert.match(grounding, /## Extensions this context expects/);
    assert.match(grounding, /### Calling them/);
    assert.match(grounding, /`pagerduty__get_incident`/);
    assert.match(grounding, /Arguments: query/);
    // Only what the context declared.
    assert.doesNotMatch(grounding, /pagerduty__search_incidents/);

    const result = await runtime.useExtension({
      tool: "pagerduty__get_incident",
      arguments: { query: "INC-1" }
    });
    assert.match(result, /get_incident ran with \{"query":"INC-1"\}/);

    assert.match(
      await runtime.useExtension({ tool: "pagerduty__search_incidents" }),
      /is not something this context can call\. It can call: pagerduty__get_incident\./
    );
    assert.match(await runtime.commandExtensions("test pagerduty"), /pagerduty: ready/);
  });

  it("stops at the context boundary and when nothing is connected", async () => {
    await declaredOrders();
    await bind({ command: process.execPath, args: [fakeServer] });
    await runtime.useExtension({ tool: "pagerduty__get_incident" });

    await createOrders("Billing");
    await runtime.commandUse("Billing");
    assert.match(
      await runtime.useExtension({ tool: "pagerduty__get_incident" }),
      /declares no extensions, so there is nothing to call/
    );
    assert.doesNotMatch(await runtime.getContext(), /Extensions this context expects/);

    await runtime.commandDisconnect();
    assert.match(
      await runtime.useExtension({ tool: "pagerduty__get_incident" }),
      /No NeatContext Context is connected/
    );
    assert.match(await runtime.commandExtensions(""), /No context is connected/);
    assert.match(await runtime.declareExtension({ id: "x", capability: "y" }), /nothing to declare/);
  });

  it("answers a command or declaration it cannot act on", async () => {
    await createOrders();
    await runtime.commandUse("Orders");
    assert.match(await runtime.commandExtensions("wat"), /Unknown extensions action "wat"/);
    assert.match(await runtime.commandExtensions("test"), /Use: \/neatcontext-extensions test/);
    assert.match(await runtime.commandExtensions("remove"), /Use: \/neatcontext-extensions remove/);
    assert.match(await runtime.declareExtension({ id: "pagerduty" }), /Pass the extension `id`/);
    assert.match(
      await runtime.declareExtension({ id: "Has Space", capability: "x" }),
      /not a usable extension id/
    );
    await runtime.declareExtension({ id: "pagerduty", capability: "Read incidents." });
    assert.match(
      await runtime.commandExtensions("remove pagerduty"),
      /no longer expects "pagerduty"/
    );
  });
});

describe("narrowing the menu to the request", () => {
  const CORPUS = [
    ["INC-1001 checkout", "checkout-api 5xx from pgbouncer pool exhaustion"],
    ["Queue lag", "order-events partition lag and consumer rebalancing"],
    ["Codex design", "Codex CLI plugin design and marketplace packaging"],
    ["Kimi plugin", "Kimi Code manifests, skills and commands"],
    ["Evidence", "conversation evidence and transcript adapters"],
    ["Refunds", "refunds and chargebacks"],
    ["Docker container", "Ubuntu container with SSH"],
    ["Marketplace config", "switching the marketplace source"],
    ["Session drift", "bridge session and thread drift"]
  ];

  async function seed() {
    for (const [name, useWhen] of CORPUS) {
      await runtime.createContext({
        name,
        knowledgeFolder: docs,
        profile: `# ${name}\n\n## Purpose\n\n${useWhen}\n`,
        useWhen
      });
    }
  }

  it("shows only the contexts the request reached", async () => {
    await seed();
    const notes = await runtime.getContext("why is checkout throwing 5xx");
    assert.match(notes, /## Contexts that match what the user just asked/);
    assert.match(notes, /INC-1001 checkout/);
    assert.ok(!notes.includes("Docker container"));
  });

  it("keeps the whole menu when there is no request to match", async () => {
    // pi appends the notes to its system prompt every turn, where there is no
    // question yet — that path must keep listing everything.
    await seed();
    const notes = await runtime.getContext();
    assert.match(notes, /## Contexts available on this machine/);
    assert.match(notes, /Docker container/);
    assert.match(await runtime.sessionInstructions(), /## Contexts available on this machine/);
  });

  it("keeps the whole menu when nothing matched", async () => {
    await seed();
    assert.match(
      await runtime.getContext("what is the capital of France"),
      /## Contexts available on this machine/
    );
  });
});

describe("saving the matching material", () => {
  const BASE = {
    name: "Pool limits June",
    profile: "# Pool limits June\n\n## Purpose\n\nThe June regression.\n",
    routingDescription: "billing-postgres default_pool_size regression after the June deploy",
    knowledge: [{ path: "session-summary.md", content: "# Summary\n\nPool exhaustion.\n" }]
  };

  it("stores the questions and entities a save supplies", async () => {
    await runtime.saveContext({
      ...BASE,
      routingQuestions: ["why was checkout throwing 5xx last week"],
      routingEntities: ["INC-1001", "checkout-api"]
    });
    const stored = (await store.listContexts()).find((entry) => entry.name === "Pool limits June");
    assert.deepEqual(stored.routingQuestions, ["why was checkout throwing 5xx last week"]);
    assert.deepEqual(stored.routingEntities, ["INC-1001", "checkout-api"]);
  });

  it("leaves stored lists alone when a save says nothing about them", async () => {
    // pi may save from a turn that never generated them; that must not wipe
    // what an earlier save wrote.
    await runtime.saveContext({
      ...BASE,
      routingQuestions: ["why was checkout throwing 5xx last week"],
      routingEntities: ["INC-1001"]
    });
    const before = (await store.listContexts()).find((entry) => entry.name === "Pool limits June");

    await runtime.saveContext({
      name: before.name,
      targetId: before.id,
      baseHash: await store.fingerprintContext(before),
      profile: "# Pool limits June\n\n## Purpose\n\nThe June regression, revisited.\n",
      routingDescription: BASE.routingDescription,
      knowledge: BASE.knowledge,
      confirm: true
    });

    const after = (await store.listContexts()).find((entry) => entry.name === "Pool limits June");
    assert.deepEqual(after.routingQuestions, before.routingQuestions);
    assert.deepEqual(after.routingEntities, before.routingEntities);
  });
});
