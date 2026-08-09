import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeSession } from "./process-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "kimi-code", "neatcontext");
const cli = path.join(pluginRoot, "src", "kimi", "neatcontext-cli.mjs");
const bridge = path.join(pluginRoot, "src", "kimi", "mcp-bridge.mjs");
const commandNames = [
  "create",
  "delete",
  "disconnect",
  "export",
  "extensions",
  "import",
  "list",
  "mode",
  "save",
  "status",
  "use"
];

function parseFrontmatter(markdown, file) {
  const normalized = markdown.replaceAll("\r\n", "\n");
  assert.ok(normalized.startsWith("---\n"), `${file} must start with YAML frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  assert.notEqual(end, -1, `${file} must close its YAML frontmatter`);
  return Object.fromEntries(
    normalized
      .slice(4, end)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        assert.notEqual(separator, -1, `${file} has invalid frontmatter: ${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );
}

function runNode(script, args = [], { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: pluginRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function localHome(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const knowledge = path.join(directory, "knowledge");
  await mkdir(knowledge, { recursive: true });
  await writeFile(path.join(knowledge, "runbook.md"), "# Runbook\n");
  return { directory, knowledge, env: { NEATCONTEXT_HOME: directory } };
}

async function createLocalContext(home, sessionId, name = "payment team", useWhen) {
  const profile = path.join(home.directory, "profile.md");
  await writeFile(profile, `# ${name}\n\n## Purpose\n${useWhen ?? "Payment support."}\n`);
  const result = await runNode(
    cli,
    [
      "--session-id",
      sessionId,
      "create",
      "--name",
      name,
      "--knowledge",
      home.knowledge,
      "--profile-from",
      profile,
      ...(useWhen ? ["--use-when", useWhen] : [])
    ],
    { env: home.env }
  );
  assert.match(result.stdout, new RegExp(`Created the "${name}" context`));
}

function rpcSession(env) {
  const child = spawn(process.execPath, [bridge], {
    cwd: pluginRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue; // notification, including tools/list_changed
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.once("error", (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });
  child.once("close", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`Kimi MCP bridge exited with ${code}. stderr: ${stderr || "(empty)"}`)
      );
    }
    pending.clear();
  });

  return {
    child,
    call(message) {
      assert.notEqual(message.id, undefined, "RPC test calls require an id");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new Error(`Timed out waiting for RPC response ${message.id}. stderr: ${stderr}`));
        }, 10000);
        timer.unref?.();
        pending.set(message.id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    async close() {
      await closeSession(child);
      assert.equal(stderr, "");
    }
  };
}

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "kimi-plugin-test", version: "1" }
    }
  };
}

function toolCall(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  };
}

test("Kimi manifests describe both repository and isolated package installs", async () => {
  const [rootText, nestedText, packageText, readme, kimiReadme] = await Promise.all([
    readFile(path.join(repositoryRoot, "kimi.plugin.json"), "utf8"),
    readFile(path.join(pluginRoot, "kimi.plugin.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(pluginRoot, "README.md"), "utf8")
  ]);
  const root = JSON.parse(rootText);
  const nested = JSON.parse(nestedText);
  const packageJson = JSON.parse(packageText);

  assert.match(root.name, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  assert.equal(root.name, "neatcontext");
  assert.equal(root.version, packageJson.version);
  assert.equal(nested.version, packageJson.version);
  assert.equal(root.sessionStart.skill, "using-neatcontext");
  assert.equal(nested.sessionStart.skill, "using-neatcontext");
  assert.equal(root.skillInstructions, nested.skillInstructions);
  assert.match(root.skillInstructions, /kimi __plugin_run_node/);
  assert.equal(root.mcpServers.neatcontext.command, "node");
  assert.equal(nested.mcpServers.neatcontext.command, "node");
  assert.equal(root.skills, "./plugins/kimi-code/neatcontext/skills/");
  assert.equal(root.commands, "./plugins/kimi-code/neatcontext/commands/");
  assert.deepEqual(root.mcpServers.neatcontext.args, [
    "./plugins/kimi-code/neatcontext/src/kimi/mcp-bridge.mjs"
  ]);
  assert.equal(root.mcpServers.neatcontext.cwd, "./");
  assert.equal(nested.skills, "./skills/");
  assert.equal(nested.commands, "./commands/");
  assert.deepEqual(nested.mcpServers.neatcontext.args, ["./src/kimi/mcp-bridge.mjs"]);
  assert.equal(nested.mcpServers.neatcontext.cwd, "./");

  for (const relative of [
    root.skills,
    root.commands,
    root.mcpServers.neatcontext.args[0]
  ]) {
    assert.ok((await stat(path.resolve(repositoryRoot, relative))).isDirectory() ||
      (await stat(path.resolve(repositoryRoot, relative))).isFile());
  }
  for (const relative of [
    nested.skills,
    nested.commands,
    nested.mcpServers.neatcontext.args[0]
  ]) {
    assert.ok((await stat(path.resolve(pluginRoot, relative))).isDirectory() ||
      (await stat(path.resolve(pluginRoot, relative))).isFile());
  }

  assert.match(readme, /\[NeatContext for Kimi Code\]\(plugins\/kimi-code\/neatcontext\/README\.md\)/);
  assert.doesNotMatch(readme, /\/plugins install|\/reload/);
  assert.match(
    kimiReadme,
    /\/plugins install https:\/\/github\.com\/XTSoftwareLabs\/neatcontext-plugins\/tree\/main/
  );
  assert.match(kimiReadme, /\/reload/);
  assert.match(
    kimiReadme,
    /!\[NeatContext for Kimi Code demo\]\(assets\/neatcontext_kimi_code_demo\.gif\)/
  );
  assert.match(kimiReadme, /^## Why NeatContext\?$/m);
  assert.match(
    kimiReadme,
    /Extract domain knowledge and preserve useful work from Kimi Code conversations/
  );
  assert.ok(
    (await stat(path.join(pluginRoot, "assets", "neatcontext_kimi_code_demo.gif"))).isFile()
  );
});

test("Kimi commands and Skills are complete, session-aware, and host-native", async () => {
  const actualCommands = (await readdir(path.join(pluginRoot, "commands")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(actualCommands, commandNames);

  const actualSkillDirs = (await readdir(path.join(pluginRoot, "skills"), {
    withFileTypes: true
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actualSkillDirs, [...commandNames, "session-start"].sort());

  for (const name of commandNames) {
    const commandFile = path.join(pluginRoot, "commands", `${name}.md`);
    const command = await readFile(commandFile, "utf8");
    const commandFrontmatter = parseFrontmatter(command, commandFile);
    assert.ok(commandFrontmatter.description);
    assert.match(command, new RegExp(`\\bneatcontext-${name}\\b`));

    const skillFile = path.join(pluginRoot, "skills", name, "SKILL.md");
    const skill = await readFile(skillFile, "utf8");
    const skillFrontmatter = parseFrontmatter(skill, skillFile);
    assert.equal(skillFrontmatter.name, `neatcontext-${name}`);
    assert.ok(skillFrontmatter.description);
    assert.match(skill, /\$\{KIMI_SKILL_DIR\}/);
    assert.match(skill, /\$\{KIMI_SESSION_ID\}/);
    assert.match(skill, /KIMI_PLUGIN_ROOT=.*kimi __plugin_run_node.* -- --session-id /);
    assert.doesNotMatch(skill, /^\s*node\s/m);
    assert.doesNotMatch(skill, /\[TODO|TODO:/);
  }

  const sessionStartFile = path.join(pluginRoot, "skills", "session-start", "SKILL.md");
  const sessionStart = await readFile(sessionStartFile, "utf8");
  const sessionFrontmatter = parseFrontmatter(sessionStart, sessionStartFile);
  assert.equal(sessionFrontmatter.name, "using-neatcontext");
  assert.equal(sessionFrontmatter.disableModelInvocation, "true");
  assert.match(sessionStart, /\$\{KIMI_SESSION_ID\}/);
  assert.match(sessionStart, /call the NeatContext `bind_session` tool/);
  assert.doesNotMatch(sessionStart, /read Kimi Code transcript files/i);

  const sourceFiles = [
    ...(await readdir(path.join(pluginRoot, "src", "core"))).map((name) =>
      path.join(pluginRoot, "src", "core", name)
    ),
    ...(await readdir(path.join(pluginRoot, "src", "kimi"))).map((name) =>
      path.join(pluginRoot, "src", "kimi", name)
    )
  ];
  const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /\bClaude\b|\bCodex\b|\$neatcontext/);
  assert.doesNotMatch(source, /from\s+["'][^"']*\/kimi\//);
});

test("Kimi CLI requires a safe session id and isolates routing and selection", async (t) => {
  const home = await localHome("neatcontext-kimi-cli-");
  t.after(() => rm(home.directory, { recursive: true, force: true }));
  const env = home.env;

  const missing = await runNode(cli, ["mode"], { env });
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /Kimi Code session id is required/);

  const unsafe = await runNode(cli, ["--session-id", "../other", "mode"], { env });
  assert.equal(unsafe.code, 0);
  assert.match(unsafe.stdout, /invalid session id/);

  const modeA = await runNode(cli, ["--session-id", "kimi-session-a", "mode", "auto"], { env });
  assert.match(modeA.stdout, /now auto for this session/);
  const currentA = await runNode(cli, ["--session-id=kimi-session-a", "mode"], { env });
  assert.match(currentA.stdout, /auto \(this session\)/);
  const currentB = await runNode(cli, ["--session-id", "kimi-session-b", "mode"], { env });
  assert.match(currentB.stdout, /auto \(the default\)/);

  await createLocalContext(home, "kimi-session-a");

  const connectedA = await runNode(
    cli,
    ["--session-id", "kimi-session-a", "use", "payment team"],
    { env }
  );
  assert.match(connectedA.stdout, /Connected the "payment team" context/);
  const statusA = await runNode(cli, ["--session-id", "kimi-session-a", "status"], { env });
  assert.match(statusA.stdout, /Connected context: payment team/);
  const statusB = await runNode(cli, ["--session-id", "kimi-session-b", "status"], { env });
  assert.match(statusB.stdout, /No context is connected yet/);

  const sessionFiles = await readdir(path.join(home.directory, "plugin-sessions"));
  assert.deepEqual(sessionFiles, ["kimi-session-a.json"]);
});

// Saving is where a session with nothing connected gets its context, and where
// a session that has one must not be moved off it.
test("Kimi save connects an unconnected session and leaves a connected one", async (t) => {
  const home = await localHome("neatcontext-kimi-save-");
  t.after(() => rm(home.directory, { recursive: true, force: true }));
  const env = home.env;
  const session = ["--session-id", "kimi-save"];

  const capture = (name, overrides = {}) => ({
    schema: 1,
    name,
    profile:
      `# ${name}\n\n## Purpose\nPreserve the payment work.\n\n` +
      "## What to do\nUse the recorded decisions.\n\n" +
      "## What to avoid\nDo not invent state.\n\n" +
      "## Behavior\nSeparate verified facts from open work.",
    routingDescription: `Questions about ${name}`,
    knowledge: [{ path: "session-summary.md", content: `# Session summary\n\n${name} is saved.` }],
    ...overrides
  });

  const write = async (file, value) => {
    const target = path.join(home.directory, file);
    await writeFile(target, JSON.stringify(value), "utf8");
    return target;
  };

  const first = await runNode(
    cli,
    [...session, "save", "--from", await write("first.json", capture("Kimi Capture")), "--consume"],
    { env }
  );
  assert.match(first.stdout, /Connected context: Kimi Capture/);
  assert.match(
    (await runNode(cli, [...session, "status"], { env })).stdout,
    /Connected context: Kimi Capture/
  );

  // Save As, from a session that is already grounded.
  const second = await runNode(
    cli,
    [...session, "save", "--from", await write("second.json", capture("Kimi Second")), "--consume"],
    { env }
  );
  assert.match(second.stdout, /Use command: \/neatcontext:use Kimi Second/);
  assert.match(second.stdout, /stays connected to "Kimi Capture"/);
  assert.match(
    (await runNode(cli, [...session, "status"], { env })).stdout,
    /Connected context: Kimi Capture/
  );

  // An update of the connected context leaves the connection exactly as it was.
  const target = await runNode(cli, [...session, "save-target", "Kimi Capture"], { env });
  const field = (label) => new RegExp(`^${label}: (.+)$`, "m").exec(target.stdout)?.[1].trim();
  const updated = await runNode(
    cli,
    [
      ...session,
      "save",
      "--from",
      await write(
        "update.json",
        capture("Kimi Capture", {
          targetId: field("Context id"),
          baseHash: field("Base hash"),
          knowledge: [
            { path: "session-summary.md", content: "# Session summary\n\nThe fix is verified." }
          ]
        })
      ),
      "--yes",
      "--consume"
    ],
    { env }
  );
  assert.match(updated.stdout, /Updated context: Kimi Capture/);
  assert.match(updated.stdout, /Use command: \/neatcontext:use Kimi Capture/);
  assert.doesNotMatch(updated.stdout, /stays connected to/);
});

test("Kimi MCP bridge exposes nothing session-dependent until binding", async (t) => {
  const home = await localHome("neatcontext-kimi-mcp-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(home.directory, { recursive: true, force: true });
  });
  const env = home.env;
  await createLocalContext(home, "kimi-mcp-a");
  const selected = await runNode(
    cli,
    ["--session-id", "kimi-mcp-a", "use", "payment team"],
    { env }
  );
  assert.match(selected.stdout, /Connected the "payment team" context/);

  const first = rpcSession(env);
  const second = rpcSession(env);
  sessions.push(first, second);

  const initialized = await first.call(initialize(1));
  assert.equal(initialized.result.serverInfo.name, "neatcontext");
  assert.match(initialized.result.instructions, /has not yet bound/);

  const unboundTools = await first.call({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  assert.deepEqual(unboundTools.result.tools.map((tool) => tool.name), ["bind_session"]);

  const staleContext = await first.call(toolCall(3, "get_context"));
  assert.equal(staleContext.result.isError, true);
  assert.match(staleContext.result.content[0].text, /Call `bind_session` once/);
  const stalePrompt = await first.call({
    jsonrpc: "2.0",
    id: 4,
    method: "prompts/get",
    params: { name: "summarize_context" }
  });
  assert.equal(stalePrompt.result.isError, true);
  assert.match(stalePrompt.result.content[0].text, /Call `bind_session` once/);

  const invalidBind = await first.call(toolCall(5, "bind_session", { session_id: "../bad" }));
  assert.equal(invalidBind.result.isError, true);
  const bound = await first.call(
    toolCall(6, "bind_session", { session_id: "kimi-mcp-a" })
  );
  assert.equal(bound.result.isError, false);
  assert.match(bound.result.content[0].text, /"payment team" context is selected/);

  // Binding the same session again is idempotent, not an error.
  const reboundSame = await first.call(
    toolCall(7, "bind_session", { session_id: "kimi-mcp-a" })
  );
  assert.equal(reboundSame.result.isError, false);
  assert.match(reboundSame.result.content[0].text, /already bound to this Kimi Code session/);

  const boundTools = await first.call({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/list",
    params: {}
  });
  const boundNames = boundTools.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(boundNames, [
    "get_context",
    "preview_context",
    "use_context"
  ]);
  const grounded = await first.call(toolCall(9, "get_context"));
  assert.match(grounded.result.content[0].text, /connected context: payment team/i);

  // A new session in the same window: the bridge process survives it, and the
  // new session's skill expansion binds the new id. The bridge must follow the
  // session that is actually asking — this used to error until Kimi restarted.
  const rebound = await first.call(
    toolCall(10, "bind_session", { session_id: "kimi-mcp-b" })
  );
  assert.equal(rebound.result.isError, false);
  assert.match(rebound.result.content[0].text, /No NeatContext context is selected/);
  const afterRebind = await first.call(toolCall(11, "get_context"));
  assert.match(afterRebind.result.content[0].text, /No NeatContext Context is connected/);
  assert.doesNotMatch(afterRebind.result.content[0].text, /Connected context: payment team/);

  // And back: re-binding the earlier session re-grounds in its selection. A
  // context belongs to the session it was connected for, not to the bridge.
  const reboundBack = await first.call(
    toolCall(12, "bind_session", { session_id: "kimi-mcp-a" })
  );
  assert.equal(reboundBack.result.isError, false);
  assert.match(reboundBack.result.content[0].text, /"payment team" context is selected/);
  const regrounded = await first.call(toolCall(13, "get_context"));
  assert.match(regrounded.result.content[0].text, /connected context: payment team/i);

  await second.call(initialize(14));
  const boundSecond = await second.call(
    toolCall(15, "bind_session", { session_id: "kimi-mcp-b" })
  );
  assert.match(boundSecond.result.content[0].text, /No NeatContext context is selected/);
  const ungrounded = await second.call(toolCall(16, "get_context"));
  assert.match(ungrounded.result.content[0].text, /No NeatContext Context is connected/);
  assert.doesNotMatch(ungrounded.result.content[0].text, /Connected context: payment team/);

});

test("Kimi narrows the routing menu to the request", async (t) => {
  const home = await localHome("neatcontext-kimi-shortlist-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(home.directory, { recursive: true, force: true });
  });

  const corpus = [
    ["INC-1001 checkout", "checkout-api 5xx from pgbouncer pool exhaustion"],
    ["Queue lag", "order-events partition lag and consumer rebalancing"],
    ["Codex design", "Codex CLI plugin design and marketplace packaging"],
    ["Kimi manifests", "Kimi Code manifests, skills and commands"],
    ["Evidence", "conversation evidence and transcript adapters"],
    ["Refunds", "refunds and chargebacks"],
    ["Docker container", "Ubuntu container with SSH"],
    ["Marketplace config", "switching the marketplace source"],
    ["Session drift", "bridge session and thread drift"]
  ];
  for (const [name, useWhen] of corpus) {
    await createLocalContext(home, "kimi-shortlist", name, useWhen);
  }

  const session = rpcSession(home.env);
  sessions.push(session);
  await session.call(initialize(1));
  await session.call(toolCall(2, "bind_session", { session_id: "kimi-shortlist" }));

  const matched = await session.call(
    toolCall(3, "get_context", { query: "why is checkout throwing 5xx" })
  );
  const narrowed = matched.result.content[0].text;
  assert.match(narrowed, /## Contexts that match what the user just asked/);
  assert.match(narrowed, /INC-1001 checkout/);
  assert.ok(!narrowed.includes("Docker container"));

  const everything = await session.call(toolCall(4, "get_context"));
  assert.match(everything.result.content[0].text, /## Contexts available on this machine/);
  assert.match(everything.result.content[0].text, /Docker container/);

  // A request that reaches nothing must not hide the store behind an empty
  // shortlist — the full menu is the safe answer.
  const unmatched = await session.call(
    toolCall(5, "get_context", { query: "what is the capital of France" })
  );
  assert.match(unmatched.result.content[0].text, /## Contexts available on this machine/);
  assert.match(unmatched.result.content[0].text, /Docker container/);

  // Nothing is connected in this session, which is the case routing exists for.
  // Leading with a slash command there is what made routing look broken: it is
  // the first thing the model reads and it answers "what now?" before the menu
  // below it gets a turn.
  assert.match(narrowed, /Connect the one this request belongs to with `use_context`/);
  assert.match(narrowed, /do not ask the user to run a command/);
});

// Manual mode publishes no menu, so there is nothing for the session to connect
// from and the command really is the only way forward.
test("Kimi falls back to the commands when routing is off", async (t) => {
  const home = await localHome("neatcontext-kimi-manual-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(home.directory, { recursive: true, force: true });
  });

  await createLocalContext(home, "kimi-manual", "Refunds", "refunds and chargebacks");
  await runNode(cli, ["--session-id", "kimi-manual", "mode", "manual"], { env: home.env });

  const session = rpcSession(home.env);
  sessions.push(session);
  await session.call(initialize(1));
  await session.call(toolCall(2, "bind_session", { session_id: "kimi-manual" }));

  const text = (await session.call(toolCall(3, "get_context", { query: "refunds" }))).result
    .content[0].text;
  assert.match(text, /Connect one with `\/neatcontext:use`/);
  assert.doesNotMatch(text, /## Contexts/);
});

// The cold start: bound, routing on, but nothing saved yet. `use` has nothing
// to list, so the answer has to lead with save rather than with the menu.
test("Kimi empty store points at save", async (t) => {
  const home = await localHome("neatcontext-kimi-empty-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(home.directory, { recursive: true, force: true });
  });

  const session = rpcSession(home.env);
  sessions.push(session);
  await session.call(initialize(1));
  await session.call(toolCall(2, "bind_session", { session_id: "kimi-empty" }));

  const text = (await session.call(toolCall(3, "get_context"))).result.content[0].text;
  assert.match(text, /nothing to list/);
  assert.match(text, /\/neatcontext:save/);
});
