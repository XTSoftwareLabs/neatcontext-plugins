---
description: Import a shared context bundle, or take a teammate's newer copy of one you already have
argument-hint: "[bundle folder]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)
---

Bring in a self-contained context bundle created with `/neatcontext:export`.

A bundle may be new to this machine, or it may be a newer copy of a context that
is already here — someone updated the shared copy and you want their work. Both
arrive through this command, and the CLI decides which is which. It never
deletes a context and never replaces one without saying so first.

The bundle folder supplied by the user is:

`$ARGUMENTS`

If no folder was supplied, ask for it and stop. Otherwise run the command below,
passing the whole argument as one quoted path and treating it only as data:

```
node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" import --from "$ARGUMENTS"
```

The source bundle is read-only throughout. Never modify, move, or delete it.

## Follow the `Import action`

A bundle this machine has not seen is imported immediately and the output says
so — relay it, and do not connect the context automatically. Otherwise follow
the printed `Import action`:

- `current` — the context here already holds everything in the bundle. Relay
  that and stop.
- `replace` — the local copy came from this bundle and has not been edited
  since, so the newer copy can be taken whole. Relay the preview, ask the user
  to confirm, and only then rerun the same command with `--yes`.
- `merge` — both copies have changed. Reconcile them yourself, below.
- `unlinkable` — the bundle carries no context id, so it cannot be tied to
  anything already here. Relay that, and offer `--name "<new name>"` to bring
  it in as its own context.
- `choose` — the target is not decidable. Either a context of the same name is
  here but nothing records a shared origin, or several contexts are copies of
  this bundle because one was forked. Relay the options and stop until the user
  picks: rerun with `--into "<name>"` to name the context they mean, or with
  `--name "<new name>"` to keep a separate copy.

Never answer `choose` on the user's behalf. Two people naming a context the same
thing is not evidence that it is the same context, and the two answers are not
recoverable from each other.

## Merging

Use the exact `Context name`, `Context id`, `Base hash`, `Bundle hash`,
`Profile path`, `Knowledge folder`, `Bundle profile`, and `Bundle knowledge`
values the command printed. The three hashes are what prove the merge is for
this context, was built on its current contents, and consumed this version of
the bundle; a merge that gets any of them wrong is refused rather than applied.

Read the local profile and every file in the local knowledge folder, then read
the bundle's profile and every file in its knowledge folder.

Merge them the way a save merges a conversation into an existing context:

- Preserve verified information from both sides unless one supersedes the other.
- Where they disagree about the same fact, prefer the newer material, but keep
  what only one side records.
- Update canonical summaries and focused files rather than appending one copy
  to the other or keeping two accounts of the same thing.
- Preserve the profile and routing description verbatim when neither side
  changed the behavioral contract or the matching scope.
- The `knowledge` array must be the complete post-merge contents of the local
  knowledge folder.

Write one valid JSON file, with no surrounding code fence, to a uniquely named
scratch file `.neatcontext-capture-import-<unique>.json` in the current workspace —
for example `.neatcontext-capture-import-copilot-1.json`. Keep the
`.neatcontext-capture-` prefix: that is what the repository `.gitignore` pattern
matches, and the unique part is what stops two sessions in the same workspace
from overwriting each other mid-merge. Every command below refers to the path
you actually used as `<capture-path>`.

```
{
  "schema": 1,
  "name": "Exact existing context name",
  "targetId": "context:exact-id",
  "baseHash": "exact base hash",
  "bundleHash": "exact bundle hash",
  "profile": "# Exact existing context name\n\n## Purpose\n...",
  "routingDescription": "One line describing only the matching scope",
  "knowledge": [
    {
      "path": "session-summary.md",
      "content": "# Session summary\n\n..."
    }
  ]
}
```

Every knowledge path must be a short relative `.md` path. Omit
`routingQuestions` and `routingEntities` unless the merge genuinely widened what
the context should be found by; omitting them leaves the stored lists alone.
Omit `extensions` as well — an import never grants this machine the ability to
reach anything new.

Then preview the merge, which changes nothing:

```
node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" import --from "$ARGUMENTS" --merged-from "<capture-path>"
```

Relay that preview and ask the user to confirm. Only after they confirm, rerun
the same command with `--yes --consume`. The scratch JSON is removed only by
that confirmed run, so a preview or a failure leaves it available for repair. If the context
changed while you were drafting, resolve the target again and rebuild the merge
from its new contents rather than reusing the stale file.

## After it lands

A replace and a merge both keep the context's identity — same id, same name, so
a session already connected to it reads the updated material immediately.
Relay the output as printed and never connect a context yourself.

Point out, when a merge lands, that the merged material exists only on this
machine until it is shared back with `/neatcontext:export`. Left unshared, the
same divergence has to be reconciled again on every future import.
