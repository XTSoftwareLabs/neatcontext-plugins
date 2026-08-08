import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const marketplaceRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(marketplaceRoot, "..");
const pluginRoot = path.join(marketplaceRoot, "plugins", "neatcontext");
const cli = path.join(pluginRoot, "src", "codex", "neatcontext-cli.mjs");
const bridge = path.join(pluginRoot, "src", "codex", "mcp-bridge.mjs");
const hook = path.join(pluginRoot, "hooks", "session-start.mjs");

function runNode(script, args = [], { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: marketplaceRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
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
  const waiting = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n") && waiting.length > 0) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      waiting.shift().resolve(JSON.parse(line));
    }
  });
  function call(message) {
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
  return {
    call,
    close() {
      child.stdin.end();
      child.kill();
    }
  };
}

test("marketplace and plugin manifests describe an isolated Codex package", async () => {
  const localMarketplace = JSON.parse(
    await readFile(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")
  );
  assert.equal(localMarketplace.plugins[0].source.path, "./plugins/neatcontext");
  assert.equal(localMarketplace.plugins[0].policy.installation, "AVAILABLE");

  const gitMarketplace = JSON.parse(
    await readFile(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"), "utf8")
  );
  assert.equal(gitMarketplace.name, "neatcontext");
  assert.equal(
    gitMarketplace.plugins[0].source.path,
    "./codex-marketplace/plugins/neatcontext"
  );
  assert.equal(gitMarketplace.plugins[0].policy.installation, "AVAILABLE");

  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  assert.equal(manifest.name, "neatcontext");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");

  const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.neatcontext.args, ["./src/codex/mcp-bridge.mjs"]);
  assert.deepEqual(mcp.mcpServers.neatcontext.env_vars, ["CODEX_THREAD_ID"]);
  assert.equal(mcp.mcpServers.neatcontext.cwd, ".");
});

test("all namespaced workflows are real skills without scaffold placeholders", async () => {
  const expected = [
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
  const actual = (await readdir(path.join(pluginRoot, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, expected);

  for (const name of expected) {
    const skill = await readFile(path.join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`, "m"));
    assert.doesNotMatch(skill, /\[TODO|TODO:/);
  }
});

test("Codex CLI isolates routing by CODEX_THREAD_ID", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-routing-"));
  const env = {
    NEATCONTEXT_HOME: home,
    CODEX_THREAD_ID: "thread-a"
  };

  const changed = await runNode(cli, ["mode", "auto"], { env });
  assert.equal(changed.code, 0);
  assert.match(changed.stdout, /Other Codex threads keep theirs/);

  const current = await runNode(cli, ["mode"], { env });
  assert.match(current.stdout, /Context routing is auto \(this session\)/);

  const other = await runNode(cli, ["mode"], {
    env: { ...env, CODEX_THREAD_ID: "thread-b" }
  });
  assert.match(other.stdout, /Context routing is auto \(the default\)/);
});

test("Codex saves conversation provenance without touching a transcript", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-save-"));
  const capturePath = path.join(home, "capture.json");
  const env = {
    NEATCONTEXT_HOME: home,
    CODEX_THREAD_ID: "save-thread"
  };
  await writeFile(
    capturePath,
    JSON.stringify({
      schema: 1,
      name: "Codex smoke context",
      profile:
        "# Codex smoke context\n\n## Purpose\nTest Codex capture.\n\n## What to do\nUse the saved facts.\n\n## What to avoid\nDo not invent facts.\n\n## Behavior\nBe concise.",
      routingDescription: "Use for Codex plugin smoke-test requests.",
      knowledge: [
        {
          path: "session-summary.md",
          content: "# Session summary\n\nThe Codex capture path works."
        }
      ]
    }),
    "utf8"
  );

  const result = await runNode(cli, ["save", "--from", capturePath, "--consume"], { env });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Use command: \$neatcontext:use Codex smoke context/);

  const contextEntries = await readdir(path.join(home, "contexts"));
  assert.equal(contextEntries.length, 1);
  const manifest = JSON.parse(
    await readFile(path.join(home, "contexts", contextEntries[0], "context.json"), "utf8")
  );
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.kind, undefined);
  assert.equal(manifest.capturedFrom, "codex-conversation");

  const connected = await runNode(cli, ["use", "Codex smoke context"], { env });
  assert.match(connected.stdout, /Connected the "Codex smoke context" context/);

  const disconnected = await runNode(cli, ["disconnect"], { env });
  assert.match(
    disconnected.stdout,
    /Disconnected the "Codex smoke context" context from this thread/
  );
  const status = await runNode(cli, ["status"], { env });
  assert.match(status.stdout, /No context is connected yet/);
});

test("SessionStart hook emits thread-scoped routing guidance", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-hook-"));
  const result = await runNode(hook, [], {
    env: {
      NEATCONTEXT_HOME: home,
      CODEX_THREAD_ID: ""
    },
    input: JSON.stringify({
      session_id: "hook-thread",
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: marketplaceRoot
    })
  });
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /NeatContext is installed/);
  assert.match(output.hookSpecificOutput.additionalContext, /No NeatContext contexts are currently available/);
  assert.match(output.hookSpecificOutput.additionalContext, /Do not call `get_context`/);
  assert.doesNotMatch(
    output.hookSpecificOutput.additionalContext,
    /call `get_context` before answering/
  );
  assert.match(output.hookSpecificOutput.additionalContext, /\$neatcontext:save/);
});

test("MCP bridge does not advertise get_context for an empty installation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-mcp-"));
  const rpc = rpcSession({
    NEATCONTEXT_HOME: home,
    CODEX_THREAD_ID: "mcp-thread"
  });
  try {
    const initialized = await rpc.call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test" } }
    });
    assert.equal(initialized.result.serverInfo.name, "neatcontext");
    assert.equal(initialized.result.capabilities.tools.listChanged, true);
    assert.match(initialized.result.instructions, /Do not call get_context merely/);
    assert.match(initialized.result.instructions, /continue normal work without NeatContext grounding/i);
    assert.doesNotMatch(initialized.result.instructions, /call the get_context tool and let/);

    const listed = await rpc.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["preview_context", "use_context"]);

    const staleCall = await rpc.call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_context", arguments: {} }
    });
    assert.match(staleCall.result.content[0].text, /Continue normal work/);
    assert.match(staleCall.result.content[0].text, /do not retry/i);
  } finally {
    rpc.close();
  }
});

test("selected contexts advertise one-shot grounding guidance", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-selected-"));
  const capturePath = path.join(home, "capture.json");
  const env = {
    NEATCONTEXT_HOME: home,
    CODEX_THREAD_ID: "selected-thread"
  };
  await writeFile(
    capturePath,
    JSON.stringify({
      schema: 1,
      name: "Selected smoke context",
      profile:
        "# Selected smoke context\n\n## Purpose\nTest selected grounding.\n\n## What to do\nUse saved evidence.\n\n## What to avoid\nDo not invent evidence.\n\n## Behavior\nBe concise.",
      routingDescription: "Use for selected Codex grounding tests.",
      knowledge: [
        {
          path: "session-summary.md",
          content: "# Session summary\n\nSelected grounding is available."
        }
      ]
    }),
    "utf8"
  );
  assert.equal((await runNode(cli, ["save", "--from", capturePath, "--consume"], { env })).code, 0);

  const hookInput = JSON.stringify({
    session_id: "selected-thread",
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: marketplaceRoot
  });
  const unselectedHookResult = await runNode(hook, [], {
    env,
    input: hookInput
  });
  assert.equal(unselectedHookResult.code, 0);
  const unselectedHook =
    JSON.parse(unselectedHookResult.stdout).hookSpecificOutput.additionalContext;
  assert.match(unselectedHook, /No NeatContext context is selected/);
  assert.match(unselectedHook, /load grounding only after `use_context` succeeds/);

  assert.equal((await runNode(cli, ["use", "Selected smoke context"], { env })).code, 0);
  const hookResult = await runNode(hook, [], { env, input: hookInput });
  assert.equal(hookResult.code, 0);
  const hookOutput = JSON.parse(hookResult.stdout).hookSpecificOutput.additionalContext;
  assert.match(hookOutput, /"Selected smoke context" context is selected/);
  assert.match(hookOutput, /otherwise reuse the existing result/);
  assert.match(hookOutput, /Do not call `get_context` merely/);

  const rpc = rpcSession(env);
  try {
    const initialized = await rpc.call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test" } }
    });
    assert.match(initialized.result.instructions, /only when its current result is not already present/);
    assert.match(initialized.result.instructions, /Never call get_context merely/);

    const listed = await rpc.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const getContext = listed.result.tools.find((tool) => tool.name === "get_context");
    assert.equal(getContext.annotations.readOnlyHint, true);
    assert.match(getContext.description, /already selected for this thread/);
    assert.match(getContext.description, /Do not call merely/);
  } finally {
    rpc.close();
  }
});
