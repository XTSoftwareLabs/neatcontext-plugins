# NeatContext for pi

Extract domain knowledge and save useful work from [pi](https://pi.dev)
conversations as structured, reusable context that you can use in later sessions
or share with others.

Part of [NeatContext plugins](https://github.com/XTSoftwareLabs/neatcontext-plugins),
which also supports Claude Code, GitHub Copilot, Codex, and Kimi Code.

## Why

Domain knowledge is what helps a model answer accurately for your team — your
systems, constraints, decisions, terminology, and ways of working.

You build that knowledge while doing hard work with a coding agent. Long
conversations about debugging, planning, incidents, and implementation already
contain discoveries that will matter again. NeatContext extracts the durable
knowledge from those conversations and saves it as a structured context.

Connect that context in a new session and the agent starts with the knowledge it
needs instead of asking you to explain everything again.

## Install

```bash
pi install npm:@xtsoftwarelabs/neatcontext-pi
```

## Commands

| Command | What it does |
| --- | --- |
| `/neatcontext-status` | What this session is grounded in, and its routing mode |
| `/neatcontext-list` | Every context you can connect |
| `/neatcontext-use [name]` | Connect a context. With no name, pick from a list |
| `/neatcontext-disconnect` | Disconnect this session's context |
| `/neatcontext-mode [auto\|ask\|manual]` | How this session may re-ground itself (`--global` for the default) |
| `/neatcontext-create` | Create a context around a knowledge folder you already have |
| `/neatcontext-save [name]` | Save this conversation's durable work as a context |
| `/neatcontext-import <folder>` | Import a shared bundle, or reconcile a newer copy of one you already have |
| `/neatcontext-export [name] --to <folder>` | Export a saved context as a shareable bundle |
| `/neatcontext-delete <name>` | Delete a context |

Each session has its own context and its own routing mode. Two pi windows can
work on different contexts at once without disturbing each other.

## Routing

With a context connected, the model sees a one-line description of every other
context on the machine and can move the session to a better one:

- **auto** (default) — it switches on a clear match and tells you it did, and
  asks first when two contexts are close.
- **ask** — it proposes a switch and waits for you.
- **manual** — it never routes; `/neatcontext-use` only.

Decline a switch once and it will not be suggested again in that session. When
routing gets it wrong, say what you call the subject — the model records that as
an alias so the same words route correctly next time.

## Privacy

The plugin stores contexts under `~/.neatcontext/` on your machine. There is no
NeatContext Desktop connection right now. See
[PRIVACY.md](https://github.com/XTSoftwareLabs/neatcontext-plugins/blob/main/PRIVACY.md).

pi extensions run with full permissions. Read the source before installing —
it is all in `extensions/` and `src/`, dependency-free, and uses only Node
built-ins.

## License

MIT
