// A small MCP client, for talking to the servers a user has bound locally.
//
// The plugin already speaks the server half of this protocol to its host. This
// is the other end: one child process per bound extension, newline-delimited
// JSON-RPC over its stdin and stdout, which is what the stdio transport is.
//
// Three properties matter more than features here, because this code runs
// inside a live coding session and a mistake in it shows up as a host that has
// stopped answering:
//
//   * Nothing is spawned through a shell. The command and its arguments come
//     from a file the user wrote, and passing them to a shell would turn a path
//     with a space or an ampersand in it into something else entirely.
//   * Every request has a deadline. A server that accepts a call and never
//     answers must not hold the session open behind it.
//   * The child's stderr is drained and kept, never forwarded. Servers write
//     diagnostics there, and on some hosts anything the plugin prints is parsed
//     as protocol.

import { spawn } from "node:child_process";
import readline from "node:readline";

export const DEFAULT_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = "2025-11-25";
const MAX_STDERR_BYTES = 8 * 1024;

export class McpClientError extends Error {}

export function createStdioMcpClient({
  command,
  args = [],
  cwd = null,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clientInfo = { name: "neatcontext", version: "0.3.3" },
  // Injectable so the tests can produce the failures a real child process
  // only produces by accident: a pipe that is already gone when we write to it.
  spawnProcess = spawn
}) {
  let child = null;
  let closed = false;
  let exitReason = null;
  let stderr = "";
  let nextId = 0;
  const pending = new Map();

  function fail(reason) {
    exitReason = exitReason ?? reason;
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new McpClientError(reason));
    }
    pending.clear();
  }

  function start() {
    child = spawnProcess(command, args, {
      cwd: cwd ?? undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });

    child.once("error", (error) => {
      fail(`could not start ${command}: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      fail(
        `${command} exited ${signal ? `on ${signal}` : `with code ${code}`}` +
          (stderr.trim().length > 0 ? `: ${lastStderrLine()}` : "")
      );
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });

    // A server that writes something other than JSON to stdout — a banner, a
    // warning — must not desynchronize the stream. Unparseable lines are
    // dropped, exactly as this plugin's own bridges drop them.
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (message?.id === undefined || message.id === null) return; // notification
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new McpClientError(message.error.message ?? "the extension returned an error"));
        return;
      }
      entry.resolve(message.result ?? {});
    });
  }

  function lastStderrLine() {
    const lines = stderr.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : "";
  }

  function request(method, params = {}) {
    if (closed) {
      return Promise.reject(new McpClientError(exitReason ?? "the extension is not running"));
    }
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpClientError(`${command} did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new McpClientError(`could not write to ${command}: ${error.message}`));
      }
    });
  }

  function notify(method, params = {}) {
    if (closed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // A server that has already gone is reported by the next request.
    }
  }

  return {
    async initialize() {
      start();
      const result = await request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo
      });
      notify("notifications/initialized");
      return result;
    },

    async listTools() {
      const result = await request("tools/list");
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return tools.filter(
        (tool) => tool && typeof tool.name === "string" && tool.name.length > 0
      );
    },

    async callTool(name, args) {
      return request("tools/call", { name, arguments: args ?? {} });
    },

    get closed() {
      return closed;
    },

    get failure() {
      return exitReason;
    },

    close() {
      closed = true;
      if (!child) return;
      try {
        child.stdin.end();
      } catch {
        // Already gone.
      }
      child.kill();
      child = null;
    }
  };
}
