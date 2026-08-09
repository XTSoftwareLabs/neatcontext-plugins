# NeatContext for GitHub Copilot

Extract domain knowledge and preserve useful work from GitHub Copilot
conversations as structured, reusable context that you can reconnect in later
sessions or share with your team.

One plugin serves both Copilot hosts: **Copilot CLI** and **Copilot in VS Code**
(Agent Plugins preview). It is a Claude-format plugin, which both hosts install
natively.

## Why NeatContext?

Domain knowledge is what helps Copilot work accurately in your environment:
your systems, constraints, decisions, terminology, and ways of working.

You naturally build that knowledge while debugging, planning, investigating
incidents, and implementing features. Those conversations contain discoveries
that will matter again, but without a durable context they remain trapped in
one session.

NeatContext extracts the reusable knowledge from that work and saves it as a
structured context. Reconnect it when you return to the domain so Copilot can
start with the knowledge it needs, or share it with teammates so everyone
benefits from what one person learned.

## Install

```bash
copilot plugin marketplace add XTSoftwareLabs/neatcontext-plugins
copilot plugin install neatcontext@neatcontext
```

## Commands

- `/neatcontext:save [name]` — save reusable work from the visible conversation.
- `/neatcontext:use [name or number]` — connect or switch this session.
- `/neatcontext:disconnect` — disconnect only this session.
- `/neatcontext:list` — list the contexts on this machine.
- `/neatcontext:status` — show the selection and routing mode.
- `/neatcontext:create` — create a context around an existing knowledge folder.
- `/neatcontext:import [folder]` — import a shared context bundle.
- `/neatcontext:export [name] [folder]` — export a saved context as a shareable bundle.
- `/neatcontext:delete [name or number]` — preview and delete a context.
- `/neatcontext:mode [auto|ask|manual]` — show or change routing behavior.

## Scope and host differences

- **Local Contexts.** The plugin stores Contexts on this machine. There is no
  NeatContext Desktop connection right now.
- **Selections are per session on Copilot CLI.** The command and MCP processes
  use Copilot's shared session identity, so they agree even when they start in
  different working directories.
- **Workspace fallback.** On a host that does not expose a session identity,
  sessions opened in the same workspace share one selection.
- **Saving is explicit.** Run `/neatcontext:save` when the visible conversation
  contains durable work worth preserving.

Contexts created here are shared with the other NeatContext plugins on
this machine — a context saved from Claude Code can be connected from Copilot,
and vice versa.

See the repository [Privacy Policy](../../../PRIVACY.md) for storage, network,
retention, and model-provider details.
