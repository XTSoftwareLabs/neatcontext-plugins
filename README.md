# NeatContext plugins

[![CI](https://github.com/XTSoftwareLabs/neatcontext-plugins/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/XTSoftwareLabs/neatcontext-plugins/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/XTSoftwareLabs/neatcontext-plugins)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](package.json)
[![License](https://img.shields.io/github/license/XTSoftwareLabs/neatcontext-plugins)](LICENSE)

Extract domain knowledge and save useful work from Claude Code, GitHub Copilot,
Kimi Code, Codex, or pi conversations as structured, reusable context that you
can use in later sessions or share with others.

![NeatContext Claude Code demo](assets/neatcontext_claude_code_demo.gif)

<p>
  <a href="https://www.youtube.com/watch?v=p3x5Pxw3XBE">
    <strong>▶ Watch the NeatContext demo</strong>
    <img
      src="https://img.youtube.com/vi/p3x5Pxw3XBE/maxresdefault.jpg"
      alt="Watch the NeatContext demo"
      width="100%"
    />
  </a>
</p>

## Why NeatContext?

Domain knowledge is what helps an LLM answer accurately for your team—your
systems, constraints, decisions, terminology, and ways of working.

You naturally build that knowledge while doing hard work with a coding agent.
Long conversations about debugging, planning, incidents, and implementation
already contain discoveries that will matter again. NeatContext extracts the
durable knowledge from those conversations and saves it as a structured context.

Connect that context in a new session or during later work, and the coding agent
can start with the knowledge it needs instead of asking you to explain everything
again. You can also share the context with teammates, so the whole team benefits
from what one person learned.

## Install

### Claude Code

```bash
claude plugin marketplace add https://github.com/XTSoftwareLabs/neatcontext-plugins.git
claude plugin install neatcontext@neatcontext --scope user
```

### GitHub Copilot (CLI and VS Code)

See [NeatContext for GitHub Copilot](plugins/copilot/neatcontext/README.md).

### Kimi Code

See [NeatContext for Kimi Code](plugins/kimi-code/neatcontext/README.md).

### Codex

See the [Codex marketplace README](codex-marketplace/README.md).

### pi

See [NeatContext for pi](plugins/pi/neatcontext/README.md).

## Quick start: reuse a complex investigation

The walkthrough below uses Claude Code.

Suppose you work through a difficult production issue with Claude:

```text
You: Some orders take ten minutes to update, but overall queue lag looks normal.
     Help me investigate.

Claude: Let's correlate Order API traces, the order-events consumer metrics,
        and the order-projection worker logs. Start with per-partition lag
        instead of the aggregate metric.

You: Grafana shows that partition 17 is falling behind while the others are
     healthy. Tempo traces show the Order API publishes events without delay.

Claude: Check the Loki logs for the order-projection workers on partition 17.
        Look for deserialization time, payload size, and the producing service.

You: The worker logs show 12-second deserialization times for large events from
     catalog-sync. Its logs confirm that bulk updates for tenant-42 all use the
     same partition key. Splitting those updates cleared the lag.

Claude: The root cause was a hot partition: large catalog-sync events blocked
        later order events, while the aggregate lag metric hid the problem. For
        similar issues, check per-partition lag, traces from the producing
        service, worker deserialization logs, payload size, and partition keys
        before scaling consumers.
```
This is the useful work you may want to save. Run `/neatcontext:save event-partition-investigation`:

```text
Claude:
Context folder: C:\Users\alex\.neatcontext\contexts\event-partition-investigation
Profile path: C:\Users\alex\.neatcontext\contexts\event-partition-investigation\profile.md
Knowledge folder: C:\Users\alex\.neatcontext\contexts\event-partition-investigation\knowledge
Connected context: event-partition-investigation
This session had no context connected, so it is now grounded in the one it just
saved. Your next messages will use its domain profile and knowledge folder.
```

The saved context keeps the investigation approach, system knowledge, findings,
and verified resolution—not the raw conversation.

This session had nothing connected, so saving also connected it — the work it
just wrote up is the work it is still doing. A session that already has a
context connected keeps it, even when you save under a new name; use
`/neatcontext:use` when you actually want to switch.

After more work on the same subject, run `/neatcontext:save` again. With no
name it updates the context this session is now connected to, previewing the
merged result and asking before applying it.

When a similar issue appears later, connect the saved context in a new Claude
Code session by using `/neatcontext:use`. The NeatContext plugin can also route you to the right context in
`auto` or `ask` mode.

```text
You: /neatcontext:use event-partition-investigation

Claude: Connected to event-partition-investigation.

You: Shipment updates are delayed, but overall queue lag is low. Help me
     investigate.

Claude: I will start with the checks from the saved context: per-partition lag,
        event size, partition keys, and deserialization time.
```

## Commands

### `/neatcontext:save [name]`

Save the useful work in the current conversation using familiar Save / Save As
behavior:

- With no name, update the connected context after confirmation. If no
  context is connected, create a new one with a name Claude derives.
- With the exact name of an existing context, update it after
  confirmation. It does not need to be connected, and saving does not switch
  the current connection.
- With a new name, create a new context.

Updates merge durable new work with the context's existing profile and
conversation knowledge. For a context created with `/neatcontext:create`, its
linked knowledge folder remains untouched; conversation-derived additions are
stored inside the context bundle.

In Claude Code, saving compiles the host's current session transcript into an
ephemeral, privacy-filtered evidence view so earlier work can still be recovered
after compaction. The model progressively sees a bounded overview, focused
literal searches, and only the sanitized blocks it needs; NeatContext does not
save a transcript view. See the
[conversation-evidence design](docs/conversation-evidence.md).

Use this after a conversation has produced decisions, plans, troubleshooting
results, implementation notes, or other work worth preserving and reusing later.

### `/neatcontext:use [name or number]`

Connect a context to the current session.

Run the command without a name to see the available choices. Each Claude Code
window keeps its own connected context.

### `/neatcontext:disconnect`

Disconnect the context from the current session. Other Claude Code windows keep
their own connections, and the context itself is not deleted.

### `/neatcontext:list`

List all contexts you can connect.

### `/neatcontext:status`

Show the context connected to the current session and the current routing mode.
It also reports problems such as missing context files or knowledge
folders.

### `/neatcontext:create`

Create a fresh context instead of saving the current conversation. Claude
asks what the context is for, which existing folder contains its knowledge, and
what to call it.

The knowledge folder stays where it is; the command does not copy, move, or
overwrite it. Later `/neatcontext:save` updates keep generated conversation
knowledge inside the context bundle.

### `/neatcontext:import [folder]`

Import a context bundle shared by someone else. Import creates your own
local copy and leaves the shared folder unchanged.

After importing, connect it with `/neatcontext:use <name>`.

### `/neatcontext:export [name] [folder]`

Copy a context saved from a conversation into a self-contained bundle
folder, so it can be moved to another machine or handed to a teammate and
brought in with `/neatcontext:import`. A subfolder named after the context is
created inside the folder you give, and the context itself is unchanged.

Contexts are shared between AI coding clients by living in one folder on
one machine, so export is what carries one beyond it.

A context created with `/neatcontext:create` cannot be exported: it links a
knowledge folder the plugin does not own, so there is nothing self-contained to
hand over. Copy that folder across yourself and re-create the context there.

### `/neatcontext:delete [name or number]`

Delete a context after confirmation.

For a context created with `/neatcontext:create`, your original knowledge folder
is left untouched. Generated conversation knowledge stored inside the context
is deleted with it.

### `/neatcontext:mode [auto|ask|manual]`

Choose how the current session switches between contexts:

- `auto` — switch on a clear match and tell you; ask when the choice is unclear;
  this is the default
- `ask` — ask before every switch, clear match or not
- `manual` — switch only when you run `/neatcontext:use`

Run `/neatcontext:mode` without an argument to show the current mode. Add
`--global` to set the default for new sessions:

```text
/neatcontext:mode auto --global
```

### `/neatcontext:extensions`

Show what the connected context expects to reach, and whether this machine
provides it.

A context can declare an extension — an MCP server that reaches a system the
domain needs, such as your incident tracker or log store. The declaration
travels with the context and says only what capability it wants. What actually
provides that capability is a binding you write yourself, in
`~/.neatcontext/extensions.json`, and it never leaves your machine.

Nothing runs until both halves exist, so a context shared with you cannot
execute anything by itself. When an extension is configured, its tools appear
to the session named `<extension>__<tool>` and go away again the moment you
switch context. When it is not, the report says exactly what is missing and the
context still answers from its profile and knowledge folder.

See the [extensions guide](docs/extensions.md) for the binding format,
credential handling, and troubleshooting.

## Context contents

A context contains:

- **One domain profile** — your team's rules, terminology, constraints, and
  preferred ways of working. It guides how Claude behaves and answers.
- **One primary knowledge folder** — TSGs, runbooks, decisions,
  troubleshooting notes, session summaries, and other knowledge Claude can
  use. When the primary folder is linked from `/neatcontext:create`, saved
  conversation additions stay in the local context bundle.

Use `/neatcontext:save` to generate one from the current conversation,
`/neatcontext:create` to use an existing knowledge folder, or
`/neatcontext:import` to add one shared by a teammate.

### How is this different from saving or resuming a conversation?

| | Best for | What you get |
|---|---|---|
| **NeatContext** | Reusing knowledge in fresh sessions or across a team | A context generated for you:<ul><li><strong>1 domain profile:</strong> your team's rules that guide LLM behavior.</li><li><strong>1 knowledge folder:</strong> TSGs, runbooks, and other team knowledge.</li></ul> Both are generated automatically. Together, they provide reusable context—not just a conversation transcript. See [Context contents](#context-contents) for details. |
| **Claude Code resume** | Continuing the same conversation | The original session and its conversation history |
| **Save or export a conversation** | Keeping a record | The raw transcript, including the back-and-forth that led to the result |

**NeatContext keeps what will help Claude work accurately next time, without carrying over the entire chat.**

## Security and data handling

- See the [Privacy Policy](PRIVACY.md) for the complete description of local
  storage, network communication, retention, and deletion.
- The host plugins run only the Node.js files bundled in this repository and
  make no outbound internet requests.
- Contexts are stored locally under `~/.neatcontext/contexts`. Saving or
  updating from a conversation first creates a gitignored
  `.neatcontext-capture-*.json` scratch file in the current project and removes
  it after a successful save.
- Claude Code hooks retain the host-provided current transcript path in bounded
  local routing state. Transcript content is read only after an explicit save,
  through a bundled reader that drops high-risk payloads and applies
  best-effort secret redaction. It creates no plugin-owned transcript index or
  compiled-view file; Claude Code may retain its output as part of the host
  session transcript.
- A connected context's profile and selected knowledge files are read into the
  active coding session when its model uses them. They are then handled like
  other content supplied to that coding host.
- Import only bundles you trust. Their profile and Markdown knowledge become
  instructions and source material available to the active model.
- Creating or updating a context never overwrites an external knowledge
  folder referenced by `/neatcontext:create`. Deleting a context always
  requires confirmation and removes its bundle-local generated knowledge.
- A context can declare the extensions it expects, but a declaration names only
  a capability. The command that provides it lives in
  `~/.neatcontext/extensions.json` on your machine, is written by you, and is
  never carried by a context you share or import. A command, environment, or
  token written next to a declaration is discarded when the context is read and
  when it is exported.
- A binding is reachable by any context that declares its id, which is what
  makes a context portable across machines. Bind what you are comfortable
  exposing to any context you connect, and use `allowedContexts` to restrict a
  binding to contexts you name. Prefer `envFrom` for credentials so they stay
  in your environment rather than in a file.
- An extension server is spawned without a shell, receives a small base
  environment plus exactly what its binding names, and is stopped when the
  session ends or switches context.

## License

MIT — see [LICENSE](LICENSE).
