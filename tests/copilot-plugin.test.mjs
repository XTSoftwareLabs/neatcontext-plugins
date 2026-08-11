// The GitHub Copilot plugin is a thin fork of the claude-code plugin: src/core
// reused verbatim, commands ported, and a local Context adapter in src/copilot.
// These tests pin the fork's contracts: what must stay byte-identical to
// claude-code, how
// sessions use the identity Copilot exposes, fall back to workspaces when a
// host exposes none, and
// that nothing here runs on its own.

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
const claudeRoot = path.join(repositoryRoot, "plugins", "claude-code", "neatcontext");
const pluginRoot = path.join(repositoryRoot, "plugins", "copilot", "neatcontext");
// Copilot reads .claude-plugin/plugin.json too, so the fork ran on the Claude
// manifest for a while. The awesome-copilot external-plugin intake does not:
// its quality gates look only under .github/plugin/, .plugin/, and the plugin
// root, and failed the v0.2.6 submission with "no plugin.json was found in any
// recognized location". This is the one location both the CLI and that intake
// accept, and it matches the marketplace index at the repository root.
const manifestFile = path.join(pluginRoot, ".github", "plugin", "plugin.json");
const cli = path.join(pluginRoot, "src", "copilot", "neatcontext-cli.mjs");
const bridge = path.join(pluginRoot, "src", "copilot", "mcp-bridge.mjs");
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
const USER_ONLY_COMMANDS = [
  "create",
  "delete",
  "disconnect",
  "export",
  "import",
  "mode",
  "save",
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

function runNode(script, args = [], { env = {}, cwd = pluginRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
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

function rpcSession(env, { cwd = pluginRoot } = {}) {
  const child = spawn(process.execPath, [bridge], {
    cwd,
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
        new Error(`Copilot MCP bridge exited with ${code}. stderr: ${stderr || "(empty)"}`)
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
      clientInfo: { name: "copilot-plugin-test", version: "1" }
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

// One isolated NeatContext home per test.
async function isolatedHome(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    directory,
    env: {
      NEATCONTEXT_HOME: directory,
      COPILOT_AGENT_SESSION_ID: ""
    }
  };
}

async function knowledgeFolder(home, files = { "runbook.md": "# Runbook\n" }) {
  const folder = path.join(home.directory, "knowledge");
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(folder, name), content, "utf8");
  }
  return folder;
}

async function createContext(
  home,
  name,
  { sessionId = "copilot-test", useWhen = `Questions about ${name}` } = {}
) {
  const folder = await knowledgeFolder(home);
  const profileFile = path.join(home.directory, `${name.replace(/\W+/g, "-")}-profile.md`);
  await writeFile(
    profileFile,
    `# ${name}\n\n## Purpose\n\nTesting the Copilot plugin.\n`,
    "utf8"
  );
  const result = await runNode(
    cli,
    [
      "create",
      "--name",
      name,
      "--knowledge",
      folder,
      "--profile-from",
      profileFile,
      "--use-when",
      useWhen
    ],
    { env: { ...home.env, NEATCONTEXT_SESSION_ID: sessionId } }
  );
  assert.match(result.stdout, new RegExp(`Created the "${name}" context`));
  return result;
}

test("Copilot plugin manifest is complete, version-aligned, and listed in the marketplace", async () => {
  const [pluginText, marketplaceText, packageText, bridgeText, readme, copilotReadme] =
    await Promise.all([
      readFile(manifestFile, "utf8"),
      readFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(bridge, "utf8"),
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
      readFile(path.join(pluginRoot, "README.md"), "utf8")
    ]);
  const plugin = JSON.parse(pluginText);
  const marketplace = JSON.parse(marketplaceText);
  const packageJson = JSON.parse(packageText);

  assert.equal(plugin.name, "neatcontext");
  assert.equal(plugin.displayName, "NeatContext");
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.license, "MIT");
  assert.match(
    bridgeText,
    new RegExp(
      `SERVER_INFO = \\{ name: "neatcontext", version: "${plugin.version.replaceAll(".", "\\.")}" \\}`
    )
  );

  const server = plugin.mcpServers.neatcontext;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/copilot/mcp-bridge.mjs"]);
  const prefix = "${CLAUDE_PLUGIN_ROOT}/";
  assert.ok((await stat(path.join(pluginRoot, server.args[0].slice(prefix.length)))).isFile());

  // Component paths in this manifest resolve from the plugin root, not from the
  // directory the manifest sits in.
  assert.equal(plugin.commands, "./commands/");
  assert.ok((await stat(path.join(pluginRoot, "commands"))).isDirectory());

  // The Claude marketplace lists the Claude plugin and nothing else. Copilot
  // uses its own format and an entry here would force a suffixed name that
  // leaks into the command namespace.
  assert.deepEqual(
    marketplace.plugins.map((candidate) => candidate.name),
    ["neatcontext"],
    ".claude-plugin/marketplace.json must list only the Claude plugin"
  );

  // Copilot installs go through this second, Copilot-format index. Its only
  // supported source is a relative path, which must keep pointing at the same
  // plugin directory.
  const copilotMarketplace = JSON.parse(
    await readFile(path.join(repositoryRoot, ".github", "plugin", "marketplace.json"), "utf8")
  );
  assert.equal(copilotMarketplace.name, "neatcontext");
  const copilotEntry = copilotMarketplace.plugins.find(
    (candidate) => candidate.name === plugin.name
  );
  assert.ok(copilotEntry, ".github/plugin/marketplace.json must list the copilot plugin");
  assert.equal(copilotEntry.version, packageJson.version);
  assert.equal(copilotEntry.source, "./plugins/copilot/neatcontext");
  assert.ok(
    (await stat(path.join(repositoryRoot, copilotEntry.source))).isDirectory(),
    "the copilot marketplace source path must resolve"
  );

  // Copilot namespaces slash commands by the installed plugin name, and a
  // marketplace install takes that name from the entry, not the manifest. If
  // the two ever diverge, the commands become /<entry-name>:list instead of
  // /neatcontext:list — which is exactly what a suffixed entry name caused.
  assert.equal(
    copilotEntry.name,
    plugin.name,
    "the marketplace entry name must match the manifest name, or the command namespace shifts"
  );
  assert.match(copilotReadme, /\/neatcontext:list/);
  assert.doesNotMatch(copilotReadme, /neatcontext-copilot/);

  assert.match(
    readme,
    /\[NeatContext for GitHub Copilot\]\(plugins\/copilot\/neatcontext\/README\.md\)/
  );
  // The marketplace is the one documented install route. Its entry is what
  // names the plugin, so the documented commands only stay right while the
  // README keeps pointing at this index rather than a direct path install.
  assert.match(copilotReadme, /copilot plugin marketplace add XTSoftwareLabs\/neatcontext-plugins/);
  assert.match(
    copilotReadme,
    new RegExp(`copilot plugin install ${copilotEntry.name}@${copilotMarketplace.name}`)
  );
  assert.match(copilotReadme, /\[Privacy Policy\]\(\.\.\/\.\.\/\.\.\/PRIVACY\.md\)/);
});

// The awesome-copilot external-plugin intake installs the plugin, then looks
// for its manifest under exactly these three paths. A manifest anywhere else
// fails both the install smoke test and the version-match gate, no matter that
// the Copilot CLI itself would have loaded it — that is how the v0.2.6
// submission (github/awesome-copilot#2530) failed. The manifest is also the
// only place the plugin's version is published to that intake, so it has to
// track package.json, which the manifest test above asserts.
test("Copilot manifest sits where the awesome-copilot intake looks for it", async () => {
  const recognized = [
    path.join(".github", "plugin", "plugin.json"),
    path.join(".plugin", "plugin.json"),
    "plugin.json"
  ];
  const found = [];
  for (const candidate of recognized) {
    const file = path.join(pluginRoot, candidate);
    if (await stat(file).then(() => true, () => false)) found.push(candidate);
  }
  assert.deepEqual(
    found,
    [path.join(".github", "plugin", "plugin.json")],
    "the intake reads the first recognized manifest, so ship exactly one"
  );

  // Two manifests is one manifest too many: whichever the host picks first
  // wins, and the other drifts unnoticed. The Claude-format copy is the one
  // that has to stay gone, because the intake cannot see it at all.
  const entries = await readdir(pluginRoot);
  assert.ok(
    !entries.includes(".claude-plugin"),
    "the copilot plugin must not carry a second, Claude-format manifest"
  );
});

// src/core is a synced copy by repo convention. Copilot ships a subset of it —
// the modules that exist only to serve Claude-specific commands are not copied
// — so the invariant is over what Copilot does ship: every one of those files
// must still match claude-code's byte for byte. A fork starting to drift has to
// show up here.
test("Copilot plugin reuses the claude-code core verbatim", async () => {
  const shared = await readdir(path.join(pluginRoot, "src", "core"));
  assert.ok(shared.includes("context-store.mjs"), "the copied core must include context-store");
  assert.ok(shared.includes("routing.mjs"), "the copied core must include routing");

  for (const name of shared) {
    const parts = ["src", "core", name];
    const [ours, theirs] = await Promise.all([
      readFile(path.join(pluginRoot, ...parts), "utf8"),
      readFile(path.join(claudeRoot, ...parts), "utf8")
    ]);
    assert.equal(ours, theirs, `${parts.join("/")} must be byte-identical to claude-code's`);
  }
});

test("Copilot commands are complete, local-only, and pre-approve only the bundled CLI", async () => {
  const actual = (await readdir(path.join(pluginRoot, "commands")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(actual, commandNames);

  for (const name of commandNames) {
    const file = path.join(pluginRoot, "commands", `${name}.md`);
    const markdown = await readFile(file, "utf8");
    const frontmatter = parseFrontmatter(markdown, file);

    assert.ok(frontmatter.description, `${file} must carry a description`);
    // Copilot reads this frontmatter as real YAML and requires a string. An
    // unquoted `argument-hint: [context name]` is a YAML flow sequence, so the
    // host rejects the whole command with "argument-hint must be a string".
    const hint = frontmatter["argument-hint"];
    if (hint !== undefined) {
      assert.match(
        hint,
        /^(["']).*\1$/,
        `${file} must quote its argument-hint so YAML reads it as a string, not a sequence`
      );
    }
    assert.ok(
      frontmatter["allowed-tools"]?.includes(
        'Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)'
      ),
      `${file} must limit its Node.js grant to the bundled CLI`
    );
    assert.doesNotMatch(
      frontmatter["allowed-tools"],
      /Bash\(node:\*\)/,
      `${file} must not grant arbitrary Node.js execution`
    );
    assert.doesNotMatch(
      markdown,
      /!`[^\r\n`]*\$ARGUMENTS/,
      `${file} must not substitute user arguments into a preprocessing shell command`
    );
    // A ported command still pointing at the claude adapter would run against
    // the wrong session scoping; one still using Claude env expansions would
    // write to a literal "${CLAUDE_PROJECT_DIR}" path on Copilot hosts.
    assert.doesNotMatch(markdown, /src\/claude\//, `${file} must call the copilot adapter`);
    assert.doesNotMatch(
      markdown,
      /CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID/,
      `${file} must not rely on Claude Code env expansions`
    );
    // Context selection and management stay within the installed plugin.
    assert.doesNotMatch(markdown, /desktop app/i, `${file} must not reference the desktop app`);
  }

  for (const name of USER_ONLY_COMMANDS) {
    const file = path.join(pluginRoot, "commands", `${name}.md`);
    const frontmatter = parseFrontmatter(await readFile(file, "utf8"), file);
    assert.equal(
      frontmatter["disable-model-invocation"],
      "true",
      `${file} must set disable-model-invocation: true`
    );
  }
});

test("Copilot CLI serves local Contexts", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-cli-");
  t.after(() => rm(home.directory, { recursive: true, force: true }));
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-cli-a" };

  await createContext(home, "copilot docs", { sessionId: "copilot-cli-a" });

  const list = await runNode(cli, ["list"], { env });
  assert.match(list.stdout, /Contexts:/);
  assert.match(list.stdout, /copilot docs/);

  const use = await runNode(cli, ["use", "copilot docs"], { env });
  assert.match(use.stdout, /Connected the "copilot docs" context/);

  const status = await runNode(cli, ["status"], { env });
  assert.match(status.stdout, /Connected context: copilot docs/);
  assert.match(status.stdout, /Context routing: auto/);

  const saveTarget = await runNode(cli, ["save-target"], { env });
  assert.match(saveTarget.stdout, /Save action: update/);
  assert.match(saveTarget.stdout, /Context name: copilot docs/);

  const disconnect = await runNode(cli, ["disconnect"], { env });
  assert.match(disconnect.stdout, /Disconnected the "copilot docs" context/);

  const other = await runNode(cli, ["status"], {
    env: { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-cli-b" }
  });
  assert.match(other.stdout, /No context is connected yet/);

});

// Saving is where a workspace with nothing connected gets its context, and
// where a workspace that has one must not be moved off it.
test("Copilot save connects an unconnected workspace and leaves a connected one", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-save-");
  t.after(() => rm(home.directory, { recursive: true, force: true }));
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-save" };

  const capture = (name, overrides = {}) => ({
    schema: 1,
    name,
    profile:
      `# ${name}\n\n## Purpose\nPreserve the Copilot work.\n\n` +
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
    ["save", "--from", await write("first.json", capture("Copilot Capture")), "--consume"],
    { env }
  );
  assert.match(first.stdout, /Connected context: Copilot Capture/);
  assert.match(
    (await runNode(cli, ["status"], { env })).stdout,
    /Connected context: Copilot Capture/
  );

  // Save As, from a workspace that is already grounded.
  const second = await runNode(
    cli,
    ["save", "--from", await write("second.json", capture("Copilot Second")), "--consume"],
    { env }
  );
  assert.match(second.stdout, /Use command: \/neatcontext:use Copilot Second/);
  assert.match(second.stdout, /stays connected to "Copilot Capture"/);
  assert.match(
    (await runNode(cli, ["status"], { env })).stdout,
    /Connected context: Copilot Capture/
  );

  // An update of the connected context leaves the connection exactly as it was.
  const target = await runNode(cli, ["save-target", "Copilot Capture"], { env });
  const field = (label) => new RegExp(`^${label}: (.+)$`, "m").exec(target.stdout)?.[1].trim();
  const updated = await runNode(
    cli,
    [
      "save",
      "--from",
      await write(
        "update.json",
        capture("Copilot Capture", {
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
  assert.match(updated.stdout, /Updated context: Copilot Capture/);
  assert.match(updated.stdout, /Use command: \/neatcontext:use Copilot Capture/);
  assert.doesNotMatch(updated.stdout, /stays connected to/);
});

test("Copilot sessions scope to the workspace when no session id is provided", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-ws-");
  const workspaceA = await mkdtemp(path.join(os.tmpdir(), "copilot-ws-a-"));
  const workspaceB = await mkdtemp(path.join(os.tmpdir(), "copilot-ws-b-"));
  // An empty override is "not set": the runs below must fall through to the
  // workspace digest even when the test runner's own environment carries ids.
  const wsEnv = {
    ...home.env,
    NEATCONTEXT_SESSION_ID: "",
    COPILOT_AGENT_SESSION_ID: ""
  };

  await createContext(home, "workspace scoped");

  const connect = await runNode(cli, ["use", "workspace scoped"], {
    env: wsEnv,
    cwd: workspaceA
  });
  assert.match(connect.stdout, /Connected the "workspace scoped" context/);

  // Same workspace, new process: the selection must be found again — this is
  // the CLI-to-MCP-server agreement the workspace digest exists for.
  const sameWorkspace = await runNode(cli, ["status"], { env: wsEnv, cwd: workspaceA });
  assert.match(sameWorkspace.stdout, /Connected context: workspace scoped/);

  const unsafeHostId = await runNode(cli, ["status"], {
    env: { ...wsEnv, COPILOT_AGENT_SESSION_ID: "../not-a-session" },
    cwd: workspaceA
  });
  assert.match(unsafeHostId.stdout, /Connected context: workspace scoped/);

  const otherWorkspace = await runNode(cli, ["status"], { env: wsEnv, cwd: workspaceB });
  assert.match(otherWorkspace.stdout, /No context is connected yet/);

  const modeA = await runNode(cli, ["mode", "auto"], { env: wsEnv, cwd: workspaceA });
  assert.match(modeA.stdout, /now auto for this session/);
  const modeB = await runNode(cli, ["mode"], { env: wsEnv, cwd: workspaceB });
  assert.match(modeB.stdout, /auto \(the default\)/);
});

test("Copilot CLI and MCP bridge share the host session across working directories", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-session-");
  const commandWorkspace = await mkdtemp(path.join(os.tmpdir(), "copilot-command-ws-"));
  const bridgeWorkspace = await mkdtemp(path.join(os.tmpdir(), "copilot-bridge-ws-"));
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await Promise.all(
      [home.directory, commandWorkspace, bridgeWorkspace].map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });
  const env = {
    ...home.env,
    NEATCONTEXT_SESSION_ID: "",
    COPILOT_AGENT_SESSION_ID: "copilot-agent-session-a"
  };

  await createContext(home, "shared session");
  const connect = await runNode(cli, ["use", "shared session"], {
    env,
    cwd: commandWorkspace
  });
  assert.match(connect.stdout, /Connected the "shared session" context/);

  const session = rpcSession(env, { cwd: bridgeWorkspace });
  sessions.push(session);
  await session.call(initialize(1));
  const grounded = await session.call(toolCall(2, "get_context"));
  assert.match(grounded.result.content[0].text, /connected context: shared session/i);

  const otherSession = await runNode(cli, ["status"], {
    env: { ...env, COPILOT_AGENT_SESSION_ID: "copilot-agent-session-b" },
    cwd: commandWorkspace
  });
  assert.match(otherSession.stdout, /No context is connected yet/);
});

test("Copilot status offers an existing workspace selection after upgrading", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-upgrade-");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "copilot-upgrade-ws-"));
  t.after(async () => {
    await Promise.all(
      [home.directory, workspace].map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });
  const workspaceEnv = {
    ...home.env,
    NEATCONTEXT_SESSION_ID: "",
    COPILOT_AGENT_SESSION_ID: ""
  };
  const sessionEnv = {
    ...workspaceEnv,
    COPILOT_AGENT_SESSION_ID: "copilot-agent-session-new"
  };

  await createContext(home, "upgrade target");
  await runNode(cli, ["use", "upgrade target"], { env: workspaceEnv, cwd: workspace });

  const status = await runNode(cli, ["status"], { env: sessionEnv, cwd: workspace });
  assert.match(status.stdout, /No context is connected yet/);
  assert.match(status.stdout, /earlier version connected "upgrade target"/);
  assert.match(status.stdout, /\/neatcontext:use upgrade target/);

  await runNode(cli, ["use", "upgrade target"], { env: sessionEnv, cwd: workspace });
  const connected = await runNode(cli, ["status"], { env: sessionEnv, cwd: workspace });
  assert.match(connected.stdout, /Connected context: upgrade target/);
  assert.doesNotMatch(connected.stdout, /earlier version connected/);

  await runNode(cli, ["delete", "upgrade target", "--yes"], {
    env: sessionEnv,
    cwd: workspace
  });
  const missing = await runNode(cli, ["status"], { env: sessionEnv, cwd: workspace });
  assert.doesNotMatch(missing.stdout, /earlier version connected/);
});

test("Copilot MCP bridge serves Contexts and routing locally", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-mcp-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-mcp-a" };

  await createContext(home, "bridge target", { sessionId: "copilot-mcp-a" });

  const session = rpcSession(env);
  sessions.push(session);

  const initialized = await session.call(initialize(1));
  assert.equal(initialized.result.serverInfo.name, "neatcontext");
  assert.match(initialized.result.instructions, /get_context/);
  assert.match(
    initialized.result.instructions,
    /call `get_context` with the user's request before `use_context`/
  );
  assert.doesNotMatch(
    initialized.result.instructions,
    /none is connected, name the one you need and connect it here with `use_context`/
  );
  assert.match(initialized.result.instructions, /Connecting a context, in GitHub Copilot/);
  assert.match(initialized.result.instructions, /no Desktop connection right now/);

  const tools = await session.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    ["get_context", "preview_context", "use_context"]
  );

  const empty = await session.call(toolCall(3, "get_context"));
  assert.equal(empty.result.isError, false);
  assert.match(empty.result.content[0].text, /No NeatContext Context is connected/);
  // A context exists and routing is on, so the answer leads with the route this
  // session can take itself rather than with a command for the user to type.
  assert.match(empty.result.content[0].text, /connect a clear choice with `use_context`/);
  // Nothing was passed to match against, so nothing was matched. The text must
  // not report a decision that was never made.
  assert.doesNotMatch(
    empty.result.content[0].text,
    /No safe automatic match was made for this call/,
    "with no query, no matching ran — saying otherwise is evidence the model acts on"
  );

  // Ask mode refuses an unrequested switch. It is set explicitly rather than
  // assumed, so this keeps testing ask mode whatever the default becomes.
  await runNode(cli, ["mode", "ask"], { env });
  const refused = await session.call(
    toolCall(4, "use_context", { context: "bridge target", reason: "test" })
  );
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /ask mode/);

  const preview = await session.call(toolCall(5, "preview_context", { context: "bridge target" }));
  assert.equal(preview.result.isError, false);
  assert.match(preview.result.content[0].text, /# bridge target/);
  assert.match(preview.result.content[0].text, /runbook\.md/);

  const switched = await session.call(
    toolCall(6, "use_context", { context: "bridge target", requested: true })
  );
  assert.equal(switched.result.isError, false);
  assert.match(switched.result.content[0].text, /Switched this session to "bridge target"/);

  const grounded = await session.call(toolCall(7, "get_context"));
  assert.equal(grounded.result.isError, false);
  assert.match(grounded.result.content[0].text, /bridge target/);
  assert.match(grounded.result.content[0].text, /profile\.md/);

  const prompts = await session.call({
    jsonrpc: "2.0",
    id: 8,
    method: "prompts/list",
    params: {}
  });
  assert.deepEqual(prompts.result.prompts, []);

  const unknown = await session.call(toolCall(9, "demo_ctx_payments"));
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /Contexts serve only get_context/);
});

// The cold start a new user actually meets: plugin installed, nothing saved
// yet. `use` has nothing to list and `create` refuses without a folder of
// documents, so guidance naming only those two sends them to two locked doors.
// Reported from a real VS Code Copilot session before this was fixed.
test("Copilot empty store points at save rather than an empty context list", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-cold-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-cold-a" };

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const answer = (await session.call(toolCall(2, "get_context"))).result.content[0].text;
  assert.match(answer, /No NeatContext Context is connected to this session/);
  assert.match(answer, /\/neatcontext:save/, "an empty store must offer save");
  assert.match(answer, /nothing to list/, "it must say why use is not the answer");
  assert.match(answer, /\/neatcontext:create/);

  // `create` demands a pre-existing folder, so it must never be the only route
  // offered to someone who has nothing yet.
  const created = await runNode(
    cli,
    ["create", "--name", "no folder", "--profile-from", "does-not-exist.md"],
    { env }
  );
  assert.match(created.stdout, /Could not read the profile file|knowledge folder is required/i);

  const status = await runNode(cli, ["status"], { env });
  assert.match(status.stdout, /\/neatcontext:save/, "status must offer save with an empty store");

  const list = await runNode(cli, ["list"], { env });
  assert.match(list.stdout, /\/neatcontext:save/, "the empty list note must offer save");
});

// The scratch capture file carries a distilled dump of the conversation, so it
// must land on a path the repository ignores, and must not be a fixed name two
// sessions in one workspace would fight over.
test("Copilot save.md writes the capture where .gitignore covers it", async () => {
  const [save, gitignore] = await Promise.all([
    readFile(path.join(pluginRoot, "commands", "save.md"), "utf8"),
    readFile(path.join(repositoryRoot, ".gitignore"), "utf8")
  ]);

  assert.match(gitignore, /^\.neatcontext-capture-\*\.json$/m);
  assert.match(save, /\.neatcontext-capture-<unique>\.json/);
  assert.doesNotMatch(
    save,
    /--from "\.[^"]*\.json"/,
    "the save commands must take the path actually written, not a hardcoded relative one"
  );
  for (const [, flag] of save.matchAll(/save --from "([^"]+)"/g)) {
    assert.equal(flag, "<capture-path>");
  }
});

test("Copilot MCP bridge hides the routing tools in manual mode", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-manual-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-manual-a" };

  const mode = await runNode(cli, ["mode", "manual"], { env });
  assert.match(mode.stdout, /now manual for this session/);

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));
  const tools = await session.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["get_context"]);
});

// Copilot ships no hooks at all: nothing runs on its own, so there is nothing
// that could prompt the user or fire on a schedule. Saving is the /neatcontext:save
// command and nothing else.
test("Copilot plugin registers no hooks and nothing that runs on its own", async () => {
  const plugin = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(plugin.hooks, undefined, "the copilot manifest must declare no hooks");

  const entries = await readdir(pluginRoot);
  assert.ok(!entries.includes("hooks"), "the copilot plugin must ship no hooks directory");

  const sources = await readdir(path.join(pluginRoot, "src", "core"));
  assert.ok(!sources.includes("save-nudge.mjs"), "the save nudge must be gone");

  const cliText = await readFile(cli, "utf8");
  assert.doesNotMatch(cliText, /save-nudge|noteSaved/);
});

test("Copilot narrows the routing menu to the request", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-shortlist-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-shortlist" };

  const corpus = [
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
  for (const [name, useWhen] of corpus) {
    await createContext(home, name, { sessionId: "copilot-shortlist", useWhen });
  }

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const tools = await session.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const getContext = tools.result.tools.find((tool) => tool.name === "get_context");
  assert.equal(getContext.inputSchema.properties.query.type, "string");

  // Auto mode, which is the default and the only one most users ever see. The
  // request is one word, so it narrows the menu without earning a connection:
  // `checkout-api` becomes three tokens but it is still one thing the user
  // typed, and one is below the floor for acting unasked.
  const matched = await session.call(toolCall(3, "get_context", { query: "checkout-api" }));
  assert.doesNotMatch(matched.result.content[0].text, /Automatically connected/);
  assert.match(matched.result.content[0].text, /## Contexts that match what the user just asked/);
  assert.match(matched.result.content[0].text, /INC-1001 checkout/);
  assert.ok(!matched.result.content[0].text.includes("Docker container"));

  // No request to match against, so nothing is hidden.
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
});

// The interaction auto-connect actually introduced, which nothing else covers:
// a store large enough for a shortlist, connected mid-call, so the menu below
// the answer is built with a `connectedId` that did not exist when the call
// arrived — and STICKY_BOOST now applies to the context this same call chose.
test("Copilot shows the shortlist against the context it just auto-connected", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-shortlist-auto-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-shortlist-auto";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };

  const corpus = [
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
  for (const [name, useWhen] of corpus) {
    await createContext(home, name, { sessionId, useWhen });
  }

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", { query: "checkout-api 5xx from pgbouncer pool exhaustion" })
  );
  const text = response.result.content[0].text;
  assert.match(text, /Automatically connected "INC-1001 checkout"/);
  assert.match(text, /## Contexts that match what the user just asked/);
  // Named as connected in the very menu the connecting call returned, so the
  // model is not invited to route again to where it already is.
  assert.match(text, /\*\*INC-1001 checkout\*\* \*\*\(connected\)\*\*/);
  assert.match(text, /Routing is on \(auto\)/);
});

test("Copilot get_context auto-connects a uniquely clear first context in auto mode", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "LM coordination", {
    sessionId,
    useWhen: "LM-PF coordination implemented in Windows ServiceManager"
  });
  await createContext(home, "Queue lag", {
    sessionId,
    useWhen: "order-events partition lag and consumer rebalancing"
  });
  const alias = await runNode(
    cli,
    ["alias", "LM coordination", "--called", "LM coordination implemented in Windows ServiceManager"],
    { env }
  );
  assert.equal(alias.code, 0);

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", {
      query: "How is LM coordination implemented in Windows ServiceManager?"
    })
  );
  assert.match(response.result.content[0].text, /Automatically connected "LM coordination"/);
  assert.match(response.result.content[0].text, /connected context: LM coordination/i);
  assert.doesNotMatch(response.result.content[0].text, /No NeatContext Context is connected/);

  const routing = JSON.parse(
    await readFile(path.join(home.directory, "plugin-routing.json"), "utf8")
  );
  assert.deepEqual(routing.decisions, [
    {
      at: routing.decisions[0].at,
      sessionId,
      from: null,
      to: "LM coordination",
      mode: "auto",
      reason: "clear query match: lm, coordination, implemented, windows, servicemanager",
      requested: false,
      automatic: true
    }
  ]);
});

// The gate is a floor on how much of the request agreed, and these are the four
// ways a match can look like two terms without being two terms.
test("Copilot get_context does not auto-connect on evidence weaker than it looks", async (t) => {
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });

  const ask = async (label, build, query) => {
    const home = await isolatedHome(`neatcontext-copilot-gate-${label}-`);
    const sessionId = `copilot-gate-${label}`;
    const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
    await build(home, sessionId, env);
    const session = rpcSession(env);
    sessions.push(session);
    await session.call(initialize(1));
    const response = await session.call(toolCall(2, "get_context", { query }));
    return response.result.content[0].text;
  };

  // One hyphenated word tokenizes into three, but the user typed one thing.
  const hyphenated = await ask(
    "hyphenated",
    (home, sessionId) =>
      createContext(home, "Checkout incident", {
        sessionId,
        useWhen: "checkout-api 5xx from pgbouncer pool exhaustion"
      }),
    "checkout-api"
  );
  assert.doesNotMatch(hyphenated, /Automatically connected/);
  assert.match(hyphenated, /Checkout incident/);

  // A CJK run contributes its characters and their pairs — seven tokens for two
  // characters, and still one thing asked about.
  const cjk = await ask(
    "cjk",
    (home, sessionId) =>
      createContext(home, "订单系统", { sessionId, useWhen: "订单延迟与消费者重平衡" }),
    "订单延迟"
  );
  assert.doesNotMatch(cjk, /Automatically connected/);

  // Two filenames from a knowledge folder are not two statements about what a
  // context is for. `FIELD_WEIGHTS` already says so; the floor has to as well.
  const filenames = await ask(
    "filenames",
    async (home, sessionId) => {
      await knowledgeFolder(home, { "deploy.md": "# deploy\n", "runbook.md": "# runbook\n" });
      await createContext(home, "Payments", { sessionId, useWhen: "settlement reconciliation" });
    },
    "where is the deploy runbook?"
  );
  assert.doesNotMatch(filenames, /Automatically connected/);

  // A one-word alias inside an ordinary sentence is weaker evidence than the
  // floor it would be skipping.
  const alias = await ask(
    "alias",
    async (home, sessionId, env) => {
      await createContext(home, "Windows notes", { sessionId, useWhen: "Windows build notes" });
      const added = await runNode(cli, ["alias", "Windows notes", "--called", "windows"], { env });
      assert.equal(added.code, 0);
    },
    "how do I install Docker on Windows?"
  );
  assert.doesNotMatch(alias, /Automatically connected/);
  assert.match(alias, /Windows notes/);
});

// Auto-connect is the one route nobody announces before it happens, so it needs
// a session it cannot leak out of. Without an id from the host, one selection
// file is shared by every window open on the same folder.
test("Copilot get_context does not auto-connect without a host session id", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-shared-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  await createContext(home, "Checkout incident", {
    sessionId: "seed",
    useWhen: "checkout-api 5xx from pgbouncer pool exhaustion"
  });

  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "", COPILOT_AGENT_SESSION_ID: "" };
  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", { query: "checkout-api 5xx pgbouncer pool exhaustion" })
  );
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);
  assert.match(response.result.content[0].text, /No NeatContext Context is connected/);
});

// A home it cannot write to must cost the caller an optimization, never the
// answer. Unguarded, the write rejected, the rejection was swallowed, and the
// request was never answered at all — as was every later one in the session.
test("Copilot get_context still answers when the auto-connection cannot be saved", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-readonly-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect-readonly";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "Checkout incident", {
    sessionId,
    useWhen: "checkout-api 5xx from pgbouncer pool exhaustion"
  });
  // The shape a read-only or permission-denied home takes from here: the
  // directory the selection is written into cannot be created.
  await writeFile(path.join(home.directory, "plugin-sessions"), "not a directory\n");

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const first = await session.call(
    toolCall(2, "get_context", { query: "checkout-api 5xx pgbouncer pool exhaustion" })
  );
  assert.equal(first.result.isError, false);
  assert.match(first.result.content[0].text, /No NeatContext Context is connected/);
  assert.doesNotMatch(first.result.content[0].text, /Automatically connected/);

  // And the session is still usable afterwards, rather than hanging on every
  // subsequent call.
  const second = await session.call(toolCall(3, "get_context", { query: "checkout-api 5xx" }));
  assert.equal(second.result.isError, false);
});

test("Copilot get_context does not auto-connect a near-tie", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-tie-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect-tie";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "Codex packaging", {
    sessionId,
    useWhen: "plugin packaging, manifests and marketplace steps"
  });
  await createContext(home, "Kimi packaging", {
    sessionId,
    useWhen: "plugin packaging, manifests and marketplace steps"
  });

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", { query: "plugin packaging manifests marketplace steps" })
  );
  assert.match(response.result.content[0].text, /No NeatContext Context is connected/);
  assert.match(response.result.content[0].text, /Codex packaging/);
  assert.match(response.result.content[0].text, /Kimi packaging/);
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);
});

test("Copilot get_context does not auto-connect a weak one-term match", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-weak-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect-weak";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "Collections", {
    sessionId,
    useWhen: "guide"
  });
  const alias = await runNode(cli, ["alias", "Collections", "--called", "id"], { env });
  assert.equal(alias.code, 0);

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(toolCall(2, "get_context", { query: "guide" }));
  assert.match(response.result.content[0].text, /No NeatContext Context is connected/);
  assert.match(response.result.content[0].text, /Collections/);
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);
});

test("Copilot get_context leaves an unrelated request unconnected", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-unrelated-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect-unrelated";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "LM coordination", {
    sessionId,
    useWhen: "LM-PF coordination implemented in Windows ServiceManager"
  });

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", { query: "What is the capital of France?" })
  );
  assert.match(response.result.content[0].text, /No NeatContext Context is connected/);
  assert.match(response.result.content[0].text, /LM coordination/);
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);

  const routing = JSON.parse(
    await readFile(path.join(home.directory, "plugin-routing.json"), "utf8")
  );
  assert.deepEqual(routing.sessions, {});
  assert.deepEqual(routing.decisions, []);
  await assert.rejects(stat(path.join(home.directory, "plugin-sessions")), {
    code: "ENOENT"
  });
});

test("Copilot get_context does not auto-connect a context declined this session", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-declined-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect-declined";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "Checkout incident", {
    sessionId,
    useWhen: "checkout-api 5xx from pgbouncer pool exhaustion"
  });

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));
  const declined = await session.call(
    toolCall(2, "use_context", { context: "Checkout incident", declined: true })
  );
  assert.equal(declined.result.isError, false);

  const response = await session.call(
    toolCall(3, "get_context", { query: "checkout-api 5xx pgbouncer pool exhaustion" })
  );
  assert.match(response.result.content[0].text, /No NeatContext Context is connected/);
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);
});

test("Copilot get_context preserves ask mode for a clear match", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-connect-ask-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-connect-ask";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "Checkout incident", {
    sessionId,
    useWhen: "checkout-api 5xx from pgbouncer pool exhaustion"
  });
  const mode = await runNode(cli, ["mode", "ask"], { env });
  assert.equal(mode.code, 0);

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", { query: "checkout-api 5xx pgbouncer pool exhaustion" })
  );
  assert.match(response.result.content[0].text, /No NeatContext Context is connected/);
  assert.match(response.result.content[0].text, /Routing is on \(ask\)/);
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);
});

test("Copilot get_context never auto-switches an existing connection", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-auto-switch-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const sessionId = "copilot-auto-switch";
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: sessionId };
  await createContext(home, "Current work", {
    sessionId,
    useWhen: "the current connected work"
  });
  await createContext(home, "Checkout incident", {
    sessionId,
    useWhen: "checkout-api 5xx from pgbouncer pool exhaustion"
  });
  const use = await runNode(cli, ["use", "Current work"], { env });
  assert.match(use.stdout, /Connected the "Current work" context/);

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));

  const response = await session.call(
    toolCall(2, "get_context", { query: "checkout-api 5xx pgbouncer pool exhaustion" })
  );
  assert.match(response.result.content[0].text, /connected context: Current work/i);
  assert.doesNotMatch(response.result.content[0].text, /Automatically connected/);
});
