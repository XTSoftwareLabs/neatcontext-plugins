// Saving a conversation is the model-assisted half of Contexts. The model
// writes a small JSON spec; these tests start at that boundary and protect what
// the plugin itself promises: validation, atomic storage, portability, reuse,
// sharing, and ownership-aware deletion.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeSession } from "./process-helpers.mjs";

const claude = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "claude-code",
  "neatcontext",
  "src",
  "claude"
);

let home;
let serial = 0;

const childEnv = () => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: "",
  // No session and no host: nothing here is about which window is asking.
  NEATCONTEXT_HOST_KEY: "",
  CLAUDE_PID: "",
  NEATCONTEXT_HOME: home
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-save-test-"));
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { recursive: true, force: true });
});

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(claude, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv()
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

function validCapture(overrides = {}) {
  return {
    schema: 1,
    name: "Conversation Capture",
    profile:
      "# Conversation Capture\n\n" +
      "## Purpose\nPreserve the checkout recovery work.\n\n" +
      "## What to do\nUse the recorded decisions.\n\n" +
      "## What to avoid\nDo not invent deployment state.\n\n" +
      "## Behavior\nSeparate verified facts from open work.",
    routingDescription: "Checkout recovery, payment retries, PAY-* tickets, and worker restarts",
    knowledge: [
      {
        path: "session-summary.md",
        content:
          "# Session summary\n\n" +
          "Implemented retry backoff in `src/payments/retry.ts`; focused tests passed."
      },
      {
        path: "implementation/decisions.md",
        content: "# Decisions\n\nUse capped exponential backoff to protect the provider."
      }
    ],
    ...overrides
  };
}

async function writeCapture(capture = validCapture()) {
  const file = path.join(home, `capture-${serial++}.json`);
  await writeFile(file, JSON.stringify(capture));
  return file;
}

async function saveCapture(capture = validCapture(), { consume = false } = {}) {
  const file = await writeCapture(capture);
  const args = ["save", "--from", file];
  if (consume) args.push("--consume");
  const output = await cli(...args);
  return { file, output };
}

function bundleFrom(output) {
  return /Context folder:\s+(.+)/.exec(output)?.[1];
}

function outputField(output, label) {
  return new RegExp(`^${label}: (.+)$`, "m").exec(output)?.[1];
}

function updateCaptureFrom(target, overrides = {}) {
  return validCapture({
    name: outputField(target, "Context name"),
    targetId: outputField(target, "Context id"),
    baseHash: outputField(target, "Base hash"),
    ...overrides
  });
}

async function createLinkedContext(name = "Linked Runbooks") {
  const folder = path.join(home, `linked-${serial++}`);
  const profileFile = path.join(home, `linked-profile-${serial++}.md`);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "runbook.md"), "# Existing runbook\n\nRestart the worker.\n");
  await writeFile(
    profileFile,
    `# ${name}\n\n## Purpose\nUse the linked runbooks.\n\n` +
      "## What to do\nFollow verified procedures.\n\n" +
      "## What to avoid\nDo not guess.\n\n" +
      "## Behavior\nCite the runbook."
  );
  const output = await cli(
    "create",
    "--name",
    name,
    "--knowledge",
    folder,
    "--profile-from",
    profileFile,
    "--use-when",
    "worker restarts and linked runbooks"
  );
  await rm(profileFile, { force: true });
  return { folder, output };
}

function openSession() {
  const child = spawn(process.execPath, [path.join(claude, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv()
  });
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    }
  });
  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    send,
    async handshake() {
      const response = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "save-test", version: "1" }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      return response;
    },
    close: () => closeSession(child)
  };
}

describe("saving the current conversation", () => {
  it("creates a self-contained context and connects the session that had none", async () => {
    const { file, output } = await saveCapture(validCapture());
    const bundle = bundleFrom(output);

    assert.deepEqual(output.split(/\r?\n/), [
      `Context folder: ${bundle}`,
      `Profile path: ${path.join(bundle, "profile.md")}`,
      `Knowledge folder: ${path.join(bundle, "knowledge")}`,
      "Connected context: Conversation Capture",
      "This session had no context connected, so it is now grounded in the one it " +
        "just saved. Your next messages will use its domain profile and knowledge folder."
    ]);
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    assert.match(await cli("status"), /Connected context: Conversation Capture/);

    const manifest = JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8"));
    assert.equal(manifest.schema, 2);
    assert.equal(manifest.kind, undefined);
    assert.equal(manifest.knowledgeFolder, "knowledge");
    assert.equal(manifest.knowledgeManaged, true);
    assert.equal(manifest.capturedFrom, "claude-code-conversation");
    assert.equal(manifest.routingDescription, validCapture().routingDescription);
    assert.equal(
      await readFile(path.join(bundle, "knowledge", "session-summary.md"), "utf8"),
      `${validCapture().knowledge[0].content}\n`
    );
    assert.equal(
      await readFile(path.join(bundle, "knowledge", "implementation", "decisions.md"), "utf8"),
      `${validCapture().knowledge[1].content}\n`
    );
  });

  // The whole rule, in one place: a save connects a session that has nothing,
  // and never moves a session that has something. Save As is the case that
  // would otherwise re-ground a conversation the user is still having.
  it("leaves a connected session on the context it is already working in", async () => {
    await saveCapture();
    assert.match(await cli("status"), /Connected context: Conversation Capture/);

    const second = await saveCapture(
      validCapture({
        name: "Second Capture",
        profile:
          "# Second Capture\n\n## Purpose\nPreserve the refund work.\n\n" +
          "## What to do\nUse the recorded decisions.\n\n" +
          "## What to avoid\nDo not invent deployment state.\n\n" +
          "## Behavior\nSeparate verified facts from open work.",
        routingDescription: "Refund reversals, ledger corrections, and REF-* tickets"
      })
    );

    assert.match(second.output, /Use command: \/neatcontext:use Second Capture/);
    assert.match(second.output, /stays connected to "Conversation Capture"/);
    assert.match(await cli("status"), /Connected context: Conversation Capture/);
    assert.match(await cli("list"), /Second Capture/);
  });

  it("connects the session to a context it updated when nothing was connected", async () => {
    await saveCapture();
    await cli("disconnect");
    assert.match(await cli("status"), /No context is connected yet/);

    const target = await cli("save-target", "Conversation Capture");
    const file = await writeCapture(
      updateCaptureFrom(target, {
        knowledge: [
          {
            path: "session-summary.md",
            content: "# Session summary\n\nRetry backoff is deployed and verified."
          }
        ]
      })
    );

    const updated = await cli("save", "--from", file, "--yes");
    assert.match(updated, /Updated context: Conversation Capture/);
    assert.match(updated, /Connected context: Conversation Capture/);
    assert.match(await cli("status"), /Connected context: Conversation Capture/);
  });

  it("remains routable from its portable manifest when the local routing cache is empty", async () => {
    const { output } = await saveCapture();
    const manifest = JSON.parse(
      await readFile(path.join(bundleFrom(output), "context.json"), "utf8")
    );
    await writeFile(
      path.join(home, "plugin-routing.json"),
      JSON.stringify({ cards: { [manifest.id]: { useWhen: "", aliases: [] } } })
    );

    const use = await cli("use", "Conversation Capture");
    assert.match(use, /Connected the "Conversation Capture" context/);
    assert.doesNotMatch(use, /no routing description yet/);

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /Conversation Capture.*Checkout recovery, payment retries/);

      const preview = await session.send("tools/call", {
        name: "preview_context",
        arguments: { context: "Conversation Capture" }
      });
      assert.match(preview.result.content[0].text, /Checkout recovery, payment retries/);
      assert.match(preview.result.content[0].text, /implementation\/decisions\.md/);
    } finally {
      await session.close();
    }
  });

  it("deletes generated knowledge with a saved context and says so before doing it", async () => {
    const { output } = await saveCapture();
    const bundle = bundleFrom(output);

    const preview = await cli("delete", "Conversation Capture");
    assert.match(preview, /generated knowledge folder .* will be deleted/s);
    assert.equal((await readdir(path.join(bundle, "knowledge"))).length, 2);

    const deleted = await cli("delete", "Conversation Capture", "--yes");
    assert.match(deleted, /generated knowledge folder .* was deleted with it/s);
    await assert.rejects(readFile(path.join(bundle, "context.json"), "utf8"), { code: "ENOENT" });
  });

  it("keeps the capture spec after validation fails so the model can repair it", async () => {
    const file = await writeCapture(validCapture({ routingDescription: "" }));
    assert.match(await cli("save", "--from", file, "--consume"), /routing description is empty/);
    assert.equal(JSON.parse(await readFile(file, "utf8")).name, "Conversation Capture");
  });

  it("reports a missing spec and malformed JSON without creating a context", async () => {
    assert.match(await cli("save"), /Pass the generated conversation capture/);
    assert.match(
      await cli("save", "--from", path.join(home, "missing.json")),
      /Could not read a valid conversation capture/
    );
    const malformed = path.join(home, "malformed.json");
    await writeFile(malformed, "{not json");
    assert.match(await cli("save", "--from", malformed), /Could not read a valid conversation capture/);
    assert.match(await cli("list"), /Contexts:\s+\(none/);
  });

  it("surfaces an unexpected filesystem failure and leaves no half-context", async () => {
    await writeFile(path.join(home, "contexts"), "not a directory");
    const file = await writeCapture();
    const output = await cli("save", "--from", file);
    assert.match(output, /NeatContext plugin error:/);
    assert.equal(await readFile(path.join(home, "contexts"), "utf8"), "not a directory");
  });

  it("still saves when the optional local routing cache cannot be updated", async () => {
    await mkdir(path.join(home, "plugin-routing.json"));
    const { output } = await saveCapture();
    assert.match(output, /Context folder:/);

    await rm(path.join(home, "plugin-routing.json"), { recursive: true, force: true });
    assert.doesNotMatch(await cli("use", "Conversation Capture"), /no routing description yet/);
  });

  it("uses Save and Save As semantics when resolving the destination", async () => {
    assert.match(await cli("save-target"), /Save action: create/);
    assert.match(await cli("save-target", "Fresh Context"), /Save action: create/);

    await saveCapture();
    // The save connected this session, so a second nameless save is Save, not
    // Save As: it updates the context the conversation is now working in.
    assert.match(await cli("save-target"), /Save action: update/);
    assert.match(await cli("save-target", "conversation capture"), /Save action: update/);
    assert.match(await cli("save-target", "Conversation"), /Save action: choose/);
    assert.match(await cli("save-target", "Conversaton Capture"), /Save action: choose/);
    assert.match(await cli("save-target", "xy"), /Save action: create/);

    await cli("use", "Conversation Capture");
    const current = await cli("save-target");
    assert.match(current, /Save action: update/);
    assert.match(current, /Context name: Conversation Capture/);
  });

  it("previews and confirms an in-place update without changing the connection", async () => {
    const { output } = await saveCapture();
    const bundle = bundleFrom(output);
    const beforeManifest = JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8"));
    await cli("use", "Conversation Capture");
    await cli("alias", "Conversation Capture", "--called", "checkout recovery");
    const session = openSession();
    try {
      await session.handshake();
      const before = await session.send("tools/call", {
        name: "get_context",
        arguments: {}
      });
      assert.match(before.result.content[0].text, /implementation\/decisions\.md/);

      const target = await cli("save-target");
      const capture = updateCaptureFrom(target, {
        profile:
          "# Conversation Capture\n\n## Purpose\nPreserve checkout recovery and deployment work.\n\n" +
          "## What to do\nUse the recorded decisions.\n\n" +
          "## What to avoid\nDo not invent deployment state.\n\n" +
          "## Behavior\nSeparate verified facts from open work.",
        routingDescription: "Checkout recovery, payment retries, deployments, and PAY-* tickets",
        knowledge: [
          {
            path: "session-summary.md",
            content: "# Session summary\n\nRetry backoff is deployed and verified."
          },
          {
            path: "runbook.md",
            content: "# Runbook\n\nCheck provider health before restarting workers."
          }
        ]
      });
      const file = await writeCapture(capture);

      const preview = await cli("save", "--from", file);
      assert.match(preview, /Update the "Conversation Capture" context/);
      assert.match(preview, /1 added, 1 updated, 1 removed/);
      assert.match(preview, /Re-run this save with --yes to confirm/);
      assert.equal(
        await readFile(path.join(bundle, "knowledge", "implementation", "decisions.md"), "utf8"),
        `${validCapture().knowledge[1].content}\n`
      );

      const updated = await cli("save", "--from", file, "--yes");
      assert.match(updated, /Updated context: Conversation Capture/);
      assert.equal(bundleFrom(updated), bundle);
      await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
      await assert.rejects(
        readFile(path.join(bundle, "knowledge", "implementation", "decisions.md"), "utf8"),
        { code: "ENOENT" }
      );
      assert.match(await readFile(path.join(bundle, "knowledge", "runbook.md"), "utf8"), /provider health/);

      const afterManifest = JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8"));
      assert.equal(afterManifest.id, beforeManifest.id);
      assert.equal(afterManifest.createdAt, beforeManifest.createdAt);
      assert.equal(afterManifest.revision, 2);
      assert.ok(afterManifest.updatedAt > beforeManifest.updatedAt);
      const routing = JSON.parse(await readFile(path.join(home, "plugin-routing.json"), "utf8"));
      assert.deepEqual(routing.cards[beforeManifest.id].aliases, ["checkout recovery"]);
      assert.match(await cli("status"), /Connected context: Conversation Capture/);

      const after = await session.send("tools/call", {
        name: "get_context",
        arguments: {}
      });
      assert.match(after.result.content[0].text, /runbook\.md/);
      assert.doesNotMatch(after.result.content[0].text, /implementation\/decisions\.md/);
    } finally {
      await session.close();
    }
  });

  it("updates a /create context while leaving its linked knowledge untouched", async () => {
    const { folder } = await createLinkedContext();
    const target = await cli("save-target", "Linked Runbooks");
    assert.match(target, /Save action: update/);
    assert.match(target, /linked folder is read-only/);

    const file = await writeCapture(
      updateCaptureFrom(target, {
        name: "Linked Runbooks",
        profile:
          "# Linked Runbooks\n\n## Purpose\nUse the linked runbooks and captured findings.\n\n" +
          "## What to do\nFollow verified procedures.\n\n" +
          "## What to avoid\nDo not guess.\n\n" +
          "## Behavior\nCite the runbook.",
        routingDescription: "worker restarts, linked runbooks, and retry findings",
        knowledge: [
          {
            path: "session-summary.md",
            content: "# Session summary\n\nThe worker also needs its retry queue drained."
          }
        ]
      })
    );

    const preview = await cli("save", "--from", file);
    assert.match(preview, /Linked knowledge folder will not be modified/);
    const updated = await cli("save", "--from", file, "--yes");
    const generated = outputField(updated, "Conversation knowledge folder");
    assert.equal(await readFile(path.join(folder, "runbook.md"), "utf8"), "# Existing runbook\n\nRestart the worker.\n");
    assert.match(await readFile(path.join(generated, "session-summary.md"), "utf8"), /retry queue/);

    await cli("use", "Linked Runbooks");
    assert.match(await cli("status"), /Conversation knowledge: .* \(1 files\)/);
    const session = openSession();
    try {
      await session.handshake();
      const context = await session.send("tools/call", {
        name: "get_context",
        arguments: {}
      });
      assert.match(context.result.content[0].text, /Conversation knowledge saved into this context/);
      assert.match(context.result.content[0].text, /session-summary\.md/);
      assert.match(context.result.content[0].text, /runbook\.md/);
    } finally {
      await session.close();
    }
    const deleted = await cli("delete", "Linked Runbooks", "--yes");
    assert.match(deleted, /knowledge folder .* was left untouched/s);
    assert.equal(
      await readFile(path.join(folder, "runbook.md"), "utf8"),
      "# Existing runbook\n\nRestart the worker.\n"
    );
    await assert.rejects(readFile(path.join(generated, "session-summary.md"), "utf8"), {
      code: "ENOENT"
    });
  });

  it("refuses to overwrite a context changed after the update was drafted", async () => {
    await saveCapture();
    const target = await cli("save-target", "Conversation Capture");
    const file = await writeCapture(
      updateCaptureFrom(target, {
        knowledge: [
          {
            path: "session-summary.md",
            content: "# Session summary\n\nA newer proposed summary."
          }
        ]
      })
    );
    await writeFile(outputField(target, "Profile path"), "# Hand-edited profile\n");

    assert.match(
      await cli("save", "--from", file, "--yes", "--consume"),
      /changed while this update was being prepared/
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).targetId, outputField(target, "Context id"));
    assert.equal(await readFile(outputField(target, "Profile path"), "utf8"), "# Hand-edited profile\n");
  });

  it("does not recreate a connected context that disappeared", async () => {
    const { output } = await saveCapture();
    await cli("use", "Conversation Capture");
    await rm(bundleFrom(output), { recursive: true, force: true });

    assert.match(await cli("save-target"), /connected context .* no longer exists/s);
    assert.match(
      await cli("save-target", "Conversation Capture"),
      /context "Conversation Capture" no longer exists/
    );
  });

  it("reports a no-op update without asking for confirmation", async () => {
    await saveCapture();
    const target = await cli("save-target", "Conversation Capture");
    const capture = updateCaptureFrom(target);
    const file = await writeCapture(capture);

    assert.match(await cli("save", "--from", file), /does not change the "Conversation Capture"/);
    const { updateCapturedContext } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    await assert.rejects(() => updateCapturedContext(capture), /does not change/);
  });
});

describe("capture validation", () => {
  it("rejects invalid identity, profile, routing, and knowledge shapes", async () => {
    const { createCapturedContext } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    const hugeProfile = "p".repeat(128 * 1024 + 1);
    const hugeFile = "x".repeat(256 * 1024 + 1);
    const totalTooLarge = [
      { path: "session-summary.md", content: "x".repeat(220 * 1024) },
      ...Array.from({ length: 4 }, (_, index) => ({
        path: `part-${index}.md`,
        content: "x".repeat(220 * 1024)
      }))
    ];
    const tooMany = [
      { path: "session-summary.md", content: "summary" },
      ...Array.from({ length: 24 }, (_, index) => ({
        path: `part-${index}.md`,
        content: "content"
      }))
    ];

    const cases = [
      [validCapture({ name: "" }), /context name is required/i],
      [validCapture({ name: "x".repeat(81) }), /under 80 characters/],
      [validCapture({ name: "two\nlines" }), /single line/],
      [validCapture({ profile: "  " }), /domain profile is empty/i],
      [validCapture({ profile: hugeProfile }), /profile under 128 KB/],
      [validCapture({ routingDescription: "" }), /routing description is empty/i],
      [validCapture({ routingDescription: "r".repeat(241) }), /under 240 characters/],
      [validCapture({ knowledge: [] }), /no knowledge files/],
      [validCapture({ knowledge: "not-an-array" }), /no knowledge files/],
      [validCapture({ knowledge: tooMany }), /24 files or fewer/],
      [
        validCapture({ knowledge: [{ path: "../session-summary.md", content: "x" }] }),
        /Invalid knowledge file path/
      ],
      [
        validCapture({ knowledge: [{ path: "session-summary.txt", content: "x" }] }),
        /must be Markdown/
      ],
      [
        validCapture({
          knowledge: [
            { path: "session-summary.md", content: "x" },
            { path: "SESSION-SUMMARY.md", content: "y" }
          ]
        }),
        /appears more than once/
      ],
      [
        validCapture({
          knowledge: [
            { path: "session-summary.md", content: "x" },
            { path: "session-summary.md/details.md", content: "y" }
          ]
        }),
        /conflicts with another path/
      ],
      [
        validCapture({ knowledge: [{ path: "session-summary.md", content: "  " }] }),
        /is empty/
      ],
      [
        validCapture({
          knowledge: [
            { path: "session-summary.md", content: "summary" },
            { path: "huge.md", content: hugeFile }
          ]
        }),
        /larger than 256 KB/
      ],
      [validCapture({ knowledge: totalTooLarge }), /under 1 MB/],
      [
        validCapture({ knowledge: [{ path: "decisions.md", content: "x" }] }),
        /must include session-summary/
      ]
    ];

    for (const [capture, expected] of cases) {
      await assert.rejects(() => createCapturedContext(capture), expected);
    }
  });

  it("rejects every non-portable path form before writing", async () => {
    const { createCapturedContext } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    const badPaths = [
      "",
      "x".repeat(181),
      "/session-summary.md",
      "a/b/c/d/session-summary.md",
      "a//session-summary.md",
      "./session-summary.md",
      "../session-summary.md",
      "bad?/session-summary.md",
      "folder./session-summary.md",
      `${"x".repeat(101)}/session-summary.md`,
      "CON.md"
    ];
    for (const badPath of badPaths) {
      await assert.rejects(
        () =>
          createCapturedContext(
            validCapture({ knowledge: [{ path: badPath, content: "summary" }] })
          ),
        /Invalid knowledge file path/
      );
    }
  });

  it("refuses a duplicate name", async () => {
    const { createCapturedContext } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    await createCapturedContext(validCapture());
    await assert.rejects(() => createCapturedContext(validCapture()), /already exists/);
  });

  it("keeps listing a schema 1 manifest that omitted its knowledge path", async () => {
    const legacy = path.join(home, "lite", "legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(
      path.join(legacy, "context.json"),
      JSON.stringify({ schema: 1, kind: "lite", id: "lite:legacy", name: "Legacy Context" })
    );
    assert.match(await cli("list"), /Legacy Context/);
  });

  it("validates update identity and limits before writing", async () => {
    const { fingerprintContext, listContexts, previewCapturedContextUpdate } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    const { output } = await saveCapture();
    const target = await cli("save-target", "Conversation Capture");
    const capture = updateCaptureFrom(target, {
      knowledge: [{ path: "session-summary.md", content: "# Session summary\n\nChanged." }]
    });

    await assert.rejects(
      () => previewCapturedContextUpdate({ ...capture, targetId: "context:not-there" }),
      /no longer exists/
    );
    await assert.rejects(
      () => previewCapturedContextUpdate({ ...capture, name: "Wrong Context" }),
      /prepared for "Wrong Context"/
    );
    await assert.rejects(
      () => previewCapturedContextUpdate({ ...capture, baseHash: "" }),
      /no base hash/
    );

    const bundle = bundleFrom(output);
    for (let index = 0; index < 23; index += 1) {
      await writeFile(path.join(bundle, "knowledge", `extra-${index}.md`), "extra");
    }
    const oversized = (await listContexts())[0];
    await assert.rejects(() => fingerprintContext(oversized), /too many generated/);
  });

  it("serializes concurrent updates and rolls a failed directory swap back", async () => {
    const {
      fingerprintContext,
      listContexts,
      replaceContextDirectory,
      updateCapturedContext
    } = await import("../plugins/claude-code/neatcontext/src/core/context-store.mjs");
    await saveCapture();
    const record = (await listContexts())[0];
    const capture = validCapture({
      targetId: record.id,
      baseHash: await fingerprintContext(record),
      knowledge: [{ path: "session-summary.md", content: "# Session summary\n\nConcurrent." }]
    });
    const results = await Promise.allSettled([
      updateCapturedContext(capture),
      updateCapturedContext(capture)
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /already being updated|changed while/);

    const latest = (await listContexts())[0];
    const staleLock = path.join(
      home,
      "contexts",
      `.update-${latest.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}.lock`
    );
    await mkdir(staleLock);
    await utimes(staleLock, new Date(0), new Date(0));
    await updateCapturedContext(
      validCapture({
        targetId: latest.id,
        baseHash: await fingerprintContext(latest),
        knowledge: [
          { path: "session-summary.md", content: "# Session summary\n\nRecovered stale lock." }
        ]
      })
    );

    const current = path.join(home, "swap-current");
    const missingStaging = path.join(home, "swap-missing");
    const backup = path.join(home, "swap-backup");
    await mkdir(current);
    await writeFile(path.join(current, "marker.txt"), "original");
    await assert.rejects(() => replaceContextDirectory(current, missingStaging, backup));
    assert.equal(await readFile(path.join(current, "marker.txt"), "utf8"), "original");
  });
});

describe("sharing a captured context", () => {
  it("imports a portable copy under a new local name and leaves the shared source alone", async () => {
    const { output } = await saveCapture();
    const original = bundleFrom(output);
    const shared = path.join(home, "shared-bundle");
    await cp(original, shared, { recursive: true });
    await cli("delete", "Conversation Capture", "--yes");

    const imported = await cli("import", "--from", shared, "--name", "Team Checkout Context");
    assert.match(imported, /Imported the "Team Checkout Context" conversation context/);
    assert.match(imported, /2 files/);
    assert.match(imported, /Connect it with:\s+\/neatcontext:use Team Checkout Context/);
    assert.match(imported, /shared source folder .* was left untouched/s);
    assert.equal(JSON.parse(await readFile(path.join(shared, "context.json"), "utf8")).name, "Conversation Capture");

    await rm(path.join(home, "plugin-routing.json"), { force: true });
    assert.doesNotMatch(await cli("use", "Team Checkout"), /no routing description yet/);
  });

  it("uses the bundle name when no local override is supplied", async () => {
    const { output } = await saveCapture(
      validCapture({ name: "Shared Original", profile: "# Shared Original\n\n## Purpose\nReuse it." })
    );
    const original = bundleFrom(output);
    const shared = path.join(home, "shared-original");
    await cp(original, shared, { recursive: true });
    await cli("delete", "Shared Original", "--yes");

    assert.match(await cli("import", "--from", shared), /Imported the "Shared Original"/);
  });

  it("rejects missing, malformed, non-portable, incomplete, and oversized bundles", async () => {
    assert.match(await cli("import"), /bundle folder is required/);
    assert.match(
      await cli("import", "--from", path.join(home, "not-there")),
      /No captured context bundle/
    );

    const malformed = path.join(home, "bundle-malformed");
    await mkdir(malformed);
    await writeFile(path.join(malformed, "context.json"), "{bad json");
    assert.match(await cli("import", "--from", malformed), /Could not read a valid context.json/);

    const wrong = path.join(home, "bundle-wrong");
    await mkdir(wrong);
    await writeFile(
      path.join(wrong, "context.json"),
      JSON.stringify({ kind: "lite", knowledgeFolder: "C:\\private-docs" })
    );
    assert.match(await cli("import", "--from", wrong), /not a portable conversation context/);

    const noProfile = path.join(home, "bundle-no-profile");
    await mkdir(noProfile);
    await writeFile(
      path.join(noProfile, "context.json"),
      JSON.stringify({
        schema: 1,
        kind: "lite",
        name: "No Profile",
        knowledgeManaged: true,
        knowledgeFolder: "knowledge",
        capturedFrom: "claude-code-conversation",
        routingDescription: "missing profile"
      })
    );
    assert.match(await cli("import", "--from", noProfile), /no readable profile.md/);

    const oversized = path.join(home, "bundle-oversized");
    await mkdir(path.join(oversized, "knowledge"), { recursive: true });
    await writeFile(
      path.join(oversized, "context.json"),
      JSON.stringify({
        schema: 1,
        kind: "lite",
        name: "Oversized",
        knowledgeManaged: true,
        knowledgeFolder: "knowledge",
        capturedFrom: "claude-code-conversation",
        routingDescription: "too many files"
      })
    );
    await writeFile(path.join(oversized, "profile.md"), "# Oversized\n\n## Purpose\nTest.");
    for (let index = 0; index < 25; index += 1) {
      await writeFile(
        path.join(oversized, "knowledge", index === 0 ? "session-summary.md" : `${index}.md`),
        "content"
      );
    }
    assert.match(await cli("import", "--from", oversized), /more than 24 knowledge files/);
  });

  it("surfaces an unexpected filesystem failure while importing", async () => {
    const { output } = await saveCapture();
    const shared = path.join(home, "shared-for-failure");
    await cp(bundleFrom(output), shared, { recursive: true });
    await rm(path.join(home, "contexts"), { recursive: true, force: true });
    await writeFile(path.join(home, "contexts"), "not a directory");

    assert.match(await cli("import", "--from", shared), /NeatContext plugin error:/);
  });
});

// Export is the only mechanism that crosses the machine boundary: contexts
// are shared between hosts by living in one folder on one machine, and nothing
// else carries them further. So what these protect is that the bundle it writes
// is exactly what import reads back, and that a context whose knowledge the
// plugin does not own is refused rather than exported hollow.
describe("exporting a captured context", () => {
  async function exportedBundle(destination, ...extra) {
    const { output } = await saveCapture();
    const exported = await cli("export", "Conversation Capture", "--to", destination, ...extra);
    return { saved: output, exported };
  }

  it("writes a bundle that imports back with its knowledge and routing intact", async () => {
    const destination = path.join(home, "exports");
    const { exported } = await exportedBundle(destination);

    assert.match(exported, /Exported the "Conversation Capture" context\./);
    assert.match(exported, /Knowledge files:\s+2/);
    assert.match(exported, /the export is a copy/);

    const bundle = /Bundle folder:\s+(.+)/.exec(exported)?.[1];
    assert.equal(path.dirname(bundle), destination);
    const manifest = JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8"));
    assert.equal(manifest.knowledgeManaged, true);
    assert.equal(manifest.knowledgeFolder, "knowledge");
    assert.deepEqual(
      (await readdir(path.join(bundle, "knowledge"), { withFileTypes: true }))
        .map((entry) => entry.name)
        .sort(),
      ["implementation", "session-summary.md"]
    );

    // The round trip is the whole point: what export writes, import must read.
    await cli("delete", "Conversation Capture", "--yes");
    const imported = await cli("import", "--from", bundle);
    assert.match(imported, /Imported the "Conversation Capture" conversation context/);
    assert.match(imported, /2 files/);
  });

  it("refuses a context whose knowledge folder belongs to the user", async () => {
    const { folder } = await createLinkedContext("Linked For Export");
    const output = await cli(
      "export",
      "Linked For Export",
      "--to",
      path.join(home, "exports-linked")
    );

    assert.match(output, /links a knowledge folder this plugin does not own/);
    assert.match(output, new RegExp(folder.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&")));
    assert.match(output, /re-create the context there with `\/neatcontext:create`/);
    assert.doesNotMatch(output, /Exported/);
  });

  it("refuses to overwrite an existing bundle until --force is given", async () => {
    const destination = path.join(home, "exports-twice");
    await exportedBundle(destination);

    const blocked = await cli("export", "Conversation Capture", "--to", destination);
    assert.match(blocked, /already exists\. Re-run the export with --force/);

    const forced = await cli("export", "Conversation Capture", "--to", destination, "--force");
    assert.match(forced, /replacing what was there/);
    const bundle = /Bundle folder:\s+(.+)/.exec(forced)?.[1];
    assert.equal(
      JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8")).name,
      "Conversation Capture"
    );
    // A rolled-back or half-finished replace would leave its scratch directories
    // behind next to the bundle.
    assert.deepEqual(
      (await readdir(destination)).filter((entry) => entry.startsWith(".neatcontext-export")),
      []
    );
  });

  it("keeps exported copies out of NeatContext's own storage", async () => {
    await saveCapture();
    const output = await cli(
      "export",
      "Conversation Capture",
      "--to",
      path.join(home, "contexts", "nested")
    );
    assert.match(output, /inside NeatContext's own context storage/);
    assert.match(output, /`\/neatcontext:import`/);
  });

  it("carries the routing description recorded after the context was saved", async () => {
    const { output } = await saveCapture();
    await cli("describe", "Conversation Capture", "--use-when", "refunds and chargeback disputes");

    const destination = path.join(home, "exports-described");
    const exported = await cli("export", "Conversation Capture", "--to", destination);
    const bundle = /Bundle folder:\s+(.+)/.exec(exported)?.[1];
    assert.equal(
      JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8")).routingDescription,
      "refunds and chargeback disputes"
    );

    // The exported copy is the one a teammate gets; the local context keeps the
    // description it already had recorded against it.
    assert.equal(
      JSON.parse(await readFile(path.join(bundleFrom(output), "context.json"), "utf8"))
        .routingDescription,
      "Checkout recovery, payment retries, PAY-* tickets, and worker restarts"
    );
  });

  it("exports the connected context when no name is given, and asks when none is", async () => {
    await saveCapture();
    // The save connected this session; export has to be asked with nothing
    // connected for the question below to be the one under test.
    await cli("disconnect");
    const destination = path.join(home, "exports-connected");

    assert.match(await cli("export", "--to", destination), /Which context should I export\?/);

    await cli("use", "Conversation Capture");
    assert.match(
      await cli("export", "--to", destination),
      /Exported the "Conversation Capture" context/
    );
  });

  it("reports what it needs instead of guessing", async () => {
    const { output } = await saveCapture();
    assert.match(await cli("export"), /Pass the destination folder with --to/);
    assert.match(
      await cli("export", "Not A Context", "--to", path.join(home, "exports-missing")),
      /No single context matched "Not A Context"/
    );
    assert.match(
      await cli("export", "Conversation Capture", "--to", path.join(bundleFrom(output), "inner")),
      /inside the context being exported/
    );
  });

  it("surfaces an unexpected filesystem failure while exporting", async () => {
    await saveCapture();
    const blocker = path.join(home, "export-blocker");
    await writeFile(blocker, "not a directory");

    assert.match(
      await cli("export", "Conversation Capture", "--to", path.join(blocker, "out")),
      /NeatContext plugin error:/
    );
  });

  it("guards the arguments and the copy that the command line cannot reach", async () => {
    const { exportContext, requireUnchangedExport, ContextError } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );

    await assert.rejects(
      () => exportContext({ destination: path.join(home, "exports-none") }),
      /No context was selected for export/
    );
    await assert.rejects(
      () => exportContext({ record: { name: "X", knowledgeManaged: true }, destination: "  " }),
      /export destination folder is required/
    );

    const record = { name: "Conversation Capture" };
    assert.equal(requireUnchangedExport(record, "same", "same"), undefined);
    assert.throws(
      () => requireUnchangedExport(record, "before", "after"),
      (error) =>
        error instanceof ContextError &&
        /changed while it was being exported\. Run the export again/.test(error.message)
    );
  });
});

describe("the Claude-facing save workflow", () => {
  it("defines a privacy-aware Save and Save As workflow", async () => {
    const root = path.resolve(claude, "..", "..");
    const saveCommand = await readFile(path.join(root, "commands", "save.md"), "utf8");
    const createCommand = await readFile(path.join(root, "commands", "create.md"), "utf8");
    const importCommand = await readFile(path.join(root, "commands", "import.md"), "utf8");

    assert.match(saveCommand, /disable-model-invocation: true/);
    assert.match(saveCommand, /model active in this session/);
    assert.match(saveCommand, /only permitted transcript reader/);
    assert.match(saveCommand, /neatcontext-cli\.mjs" evidence/);
    assert.match(saveCommand, /evidence --search/);
    assert.match(saveCommand, /evidence --show/);
    assert.match(saveCommand, /evidence --coverage-from/);
    assert.match(saveCommand, /Lexical absence is not proof/);
    assert.match(saveCommand, /session-summary\.md/);
    assert.match(saveCommand, /Never write secret values/);
    assert.match(saveCommand, /Save \/ Save As semantics/);
    assert.match(saveCommand, /save-target/);
    assert.match(saveCommand, /Relay that preview and ask the user to confirm/);
    assert.match(saveCommand, /save --from .* --yes/);
    assert.match(saveCommand, /linked knowledge folder is\s+read-only/);
    assert.match(saveCommand, /removes the scratch JSON only after a successful create/);
    assert.match(saveCommand, /never connect a context yourself/);
    assert.match(saveCommand, /A session that already had one keeps it/);
    assert.match(createCommand, /fresh context/);
    assert.match(createCommand, /\/neatcontext:save/);
    assert.match(importCommand, /source bundle is read-only/);

    const exportCommand = await readFile(path.join(root, "commands", "export.md"), "utf8");
    assert.match(exportCommand, /disable-model-invocation: true/);
    assert.match(exportCommand, /\/neatcontext:import/);
    assert.match(exportCommand, /cannot be exported/);
    assert.match(exportCommand, /--force/);
  });

  it("advertises every command in the CLI help", async () => {
    assert.match(
      await cli("not-a-command"),
      /status \| list \| use \| disconnect \| create \| save-target \| evidence \| save \| import \| export \| delete/
    );
  });

  it("rejects capture specs from an unknown schema version", async () => {
    const file = await writeCapture(validCapture({ schema: 99 }));
    assert.match(await cli("save", "--from", file), /Unsupported conversation capture schema/);
  });
});
