# NeatContext for Codex

Extract domain knowledge and save useful work from a Codex conversation as
structured, reusable context that you can use in later threads or share with
others.

## Why NeatContext?

Domain knowledge is what helps an LLM answer accurately for your team—your
systems, constraints, decisions, terminology, and ways of working.

You naturally build that knowledge while doing hard work with Codex. Long
conversations about debugging, planning, incidents, and implementation already
contain discoveries that will matter again. NeatContext extracts the durable
knowledge from those conversations and saves it as a structured context.

Connect that context in a new thread or during later work, and Codex can start
with the knowledge it needs instead of asking you to explain everything again.
You can also share the context with teammates, so the whole team benefits from
what one person learned.

## Install

```bash
codex plugin marketplace add XTSoftwareLabs/neatcontext-plugins
codex plugin add neatcontext@neatcontext
```

## Quick start: reuse a complex investigation

Suppose you work through a difficult production issue with Codex:

```text
You: Some orders take ten minutes to update, but overall queue lag looks normal.
     Help me investigate.

Codex: Let's correlate Order API traces, the order-events consumer metrics,
       and the order-projection worker logs. Start with per-partition lag
       instead of the aggregate metric.

You: Grafana shows that partition 17 is falling behind while the others are
     healthy. Tempo traces show the Order API publishes events without delay.

Codex: Check the Loki logs for the order-projection workers on partition 17.
       Look for deserialization time, payload size, and the producing service.

You: The worker logs show 12-second deserialization times for large events from
     catalog-sync. Its logs confirm that bulk updates for tenant-42 all use the
     same partition key. Splitting those updates cleared the lag.

Codex: The root cause was a hot partition: large catalog-sync events blocked
       later order events, while the aggregate lag metric hid the problem. For
       similar issues, check per-partition lag, traces from the producing
       service, worker deserialization logs, payload size, and partition keys
       before scaling consumers.
```

This is useful work you may want to save. Invoke the save skill:

```text
You: $neatcontext:save event-partition-investigation

Codex:
Context folder: C:\Users\alex\.neatcontext\contexts\event-partition-investigation
Profile path: C:\Users\alex\.neatcontext\contexts\event-partition-investigation\profile.md
Knowledge folder: C:\Users\alex\.neatcontext\contexts\event-partition-investigation\knowledge
Connected context: event-partition-investigation
This session had no context connected, so it is now grounded in the one it just
saved. Your next messages will use its domain profile and knowledge folder.
```

The saved context keeps the investigation approach, system knowledge, findings,
and verified resolution—not the raw conversation.

This thread had nothing connected, so saving also connected it — the work it
just wrote up is the work it is still doing. A thread that already has a context
connected keeps it, even when you save under a new name; use `$neatcontext:use`
when you actually want to switch.

After more work on the same subject, invoke `$neatcontext:save` again. With no
name it updates the context this thread is now connected to, previewing the
merged result and asking before applying it.

When a similar issue appears later, connect the saved context in a new Codex
thread with `$neatcontext:use`. NeatContext can also route you to the right
context in `auto` or `ask` mode.

```text
You: $neatcontext:use event-partition-investigation

Codex: Connected to event-partition-investigation.

You: Shipment updates are delayed, but overall queue lag is low. Help me
     investigate.

Codex: I will start with the checks from the saved context: per-partition lag,
       event size, partition keys, and deserialization time.
```

## Skills

Codex can select an installed NeatContext skill when your request matches its
purpose. Use a `$` mention when you want to invoke a specific skill explicitly.

### `$neatcontext:save [name]`

Save useful work from the current conversation using familiar Save / Save As
behavior:

- With no name, update the connected context after confirmation. If no
  context is connected, create a new one with a name Codex derives.
- With the exact name of an existing context, update it after
  confirmation. It does not need to be connected, and saving does not switch
  the current connection.
- With a new name, create a new context.

Updates merge durable new work with the context's existing profile and
conversation knowledge. For a context created with `$neatcontext:create`, its
linked knowledge folder remains untouched; conversation-derived additions are
stored inside the context bundle.

Use this after a conversation has produced decisions, plans, troubleshooting
results, implementation notes, or other work worth preserving and reusing
later.

### `$neatcontext:use [name or number]`

Connect a context to the current Codex thread.

Invoke the skill without a name to see the available choices. Each Codex thread
keeps its own connected context.

### `$neatcontext:disconnect`

Disconnect the context from the current Codex thread. Other threads keep their
own connections, and the context itself is not deleted.

### `$neatcontext:list`

List all contexts you can connect.

### `$neatcontext:status`

Show the context connected to the current thread and the current routing mode.
It also reports problems such as missing context files or knowledge
folders.

### `$neatcontext:create`

Create a fresh context instead of saving the current conversation. Codex
asks what the context is for, which existing folder contains its knowledge, and
what to call it.

The knowledge folder stays where it is; the skill does not copy, move, or
overwrite it. Later `$neatcontext:save` updates keep generated conversation
knowledge inside the context bundle.

### `$neatcontext:import [folder]`

Import a context bundle shared by someone else. The shared folder is only ever
read: importing makes your own local copy and never writes back to it.

A bundle you already imported can be imported again — that is how you pick up a
teammate's newer work. Import recognises the copy it gave you and says what
taking the update would cost, rather than building a second context beside it:

- Nothing new in the bundle, and it says so.
- Your copy untouched since it arrived, so the newer one replaces it whole once
  you confirm. It stays the same context, so a session connected to it picks the
  material up immediately.
- Both copies changed, so the two are reconciled into one and previewed before
  anything is written. Your work is never dropped in favour of theirs.
- A name already taken by a context with no shared origin, which import will not
  guess about: it asks whether the two are the same context or a collision, and
  waits.

A context is never deleted to make room for an imported one.

After importing, connect it with `$neatcontext:use <name>`.

A merge lives only on your machine until you share it back with
`$neatcontext:export`. Left unshared, the same divergence has to be
reconciled again every time you import.

### `$neatcontext:export [name] [folder]`

Copy a context saved from a conversation into a self-contained bundle
folder, so it can be moved to another machine or handed to a teammate and
brought in with `$neatcontext:import`. A subfolder named after the context is
created inside the folder you give, and the context itself is unchanged.

Contexts are shared between AI coding clients by living in one folder on
one machine, so export is what carries one beyond it.

A context created with `$neatcontext:create` cannot be exported: it links a
knowledge folder the plugin does not own, so there is nothing self-contained to
hand over. Copy that folder across yourself and re-create the context there.

### `$neatcontext:delete [name or number]`

Delete a context after confirmation.

For a context created with `$neatcontext:create`, your original knowledge folder
is left untouched. Generated conversation knowledge stored inside the context
is deleted with it.

### `$neatcontext:mode [auto|ask|manual]`

Choose how the current thread switches between contexts:

- `auto` — switch on a clear match and tell you; ask when the choice is unclear;
  this is the default
- `ask` — ask before every switch, clear match or not
- `manual` — switch only when you invoke `$neatcontext:use`

Invoke `$neatcontext:mode` without an argument to show the current mode. Add
`--global` to set the default for new threads:

```text
$neatcontext:mode auto --global
```

## Context contents

A context contains:

- **One domain profile** — your team's rules, terminology, constraints, and
  preferred ways of working. It guides how Codex behaves and answers.
- **One primary knowledge folder** — TSGs, runbooks, decisions,
  troubleshooting notes, session summaries, and other knowledge Codex can use.
  When the primary folder is linked from `$neatcontext:create`, saved
  conversation additions stay in the local context bundle.

Use `$neatcontext:save` to generate one from the current conversation,
`$neatcontext:create` to use an existing knowledge folder, or
`$neatcontext:import` to add one shared by a teammate.

## License

MIT — see [LICENSE](plugins/neatcontext/LICENSE).
