// A real stdio MCP server, small enough to misbehave on request.
//
// The extension runtime's whole job is talking to programs it did not write, so
// the tests drive an actual child process over an actual pipe rather than a stub
// object. The environment variables below are how a test asks this one to be the
// particular kind of broken it wants to see.
//
//   FAKE_MCP_TOOLS         comma-separated tool names to offer (default: two)
//   FAKE_MCP_REQUIRE_ENV   exit 1 unless this variable is set
//   FAKE_MCP_HANG          never answer this method
//   FAKE_MCP_EXIT_AFTER    exit once this many requests have been answered
//   FAKE_MCP_ERROR_TOOL    return a JSON-RPC error when this tool is called
//   FAKE_MCP_NOISE         write a non-JSON banner line to stdout first
//   FAKE_MCP_ECHO_ENV      report this variable's value from the `echo_env` tool
//   FAKE_MCP_PID_FILE      write this process's pid here, so a test that cares
//                          whether the child outlived its host can go and look

import { writeFileSync } from "node:fs";
import readline from "node:readline";

const required = process.env.FAKE_MCP_REQUIRE_ENV;
if (required && !process.env[required]) {
  process.stderr.write(`missing ${required}\n`);
  process.exit(1);
}

if (process.env.FAKE_MCP_PID_FILE) {
  writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid), "utf8");
}

const toolNames = (process.env.FAKE_MCP_TOOLS ?? "search_incidents,get_incident").split(",");
const hang = process.env.FAKE_MCP_HANG ?? "";
const exitAfter = Number(process.env.FAKE_MCP_EXIT_AFTER ?? "0");
const errorTool = process.env.FAKE_MCP_ERROR_TOOL ?? "";

if (process.env.FAKE_MCP_NOISE) {
  process.stdout.write("fake-extension-server listening\n");
}

let answered = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  answered += 1;
  if (exitAfter > 0 && answered >= exitAfter) {
    process.stderr.write("fake server going away\n");
    process.exit(3);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  if (message.method === hang) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-extension", version: "1.0.0" }
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: toolNames.filter(Boolean).map((name) => {
          // A server is allowed to describe a tool sparsely, and the runtime has
          // to hand the host something usable either way.
          if (name.startsWith("bare_")) return { name };
          return {
            name,
            description: `The ${name} tool.`,
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              additionalProperties: false
            }
          };
        })
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === errorTool) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `${name} is not available right now` }
      });
      return;
    }
    if (name === "echo_env") {
      const wanted = process.env.FAKE_MCP_ECHO_ENV ?? "";
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `${wanted}=${process.env[wanted] ?? "(unset)"}` }],
          isError: false
        }
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          { type: "text", text: `${name} ran with ${JSON.stringify(message.params?.arguments ?? {})}` }
        ],
        isError: false
      }
    });
    return;
  }

  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
rl.on("close", () => process.exit(0));
