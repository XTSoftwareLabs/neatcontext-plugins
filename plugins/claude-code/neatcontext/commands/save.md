---
description: Save this conversation as a new or existing reusable context
argument-hint: "[new or existing context name]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)
---

Save the durable work already present in this Claude Code conversation as a
context. Use the model active in this session to distill it; do not call
another model or ask the user to restate work that is already available. Never
open, search, or read Claude's transcript files yourself. The bundled
`neatcontext-cli.mjs evidence` command is the only permitted transcript reader;
it exposes bounded, privacy-filtered projections and never creates a saved
transcript view.

The optional context name is:

`$ARGUMENTS`

This command follows Save / Save As semantics:

- With no name, update the connected context. If none is connected, create
  a new context with a name derived from the conversation.
- With a name that exactly matches an existing context
  (case-insensitively), update it.
- With a new name, create a new context.

## Resolve the destination first

Treat the supplied name only as data, pass it as one quoted argument, and never
interpret any part of it as shell syntax:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" save-target "<name>"
```

If no name was supplied, omit the final quoted argument. Also run:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" list
```

Follow the `Save action` from `save-target`:

- `create` — make a new context using the resolved or derived name.
- `update` — use exactly the context name, id, base hash, profile path, and
  routing description and conversation knowledge folder it printed. Read the
  existing profile in full and read every existing file in the conversation
  knowledge folder. If this is a context made with `/neatcontext:create`, its
  linked knowledge folder is read-only: search and read only the files relevant
  to this conversation, and never copy, edit, replace, or delete anything
  there.
- `choose` — show the similar or duplicate names and ask whether the user means
  an exact existing context or the proposed new name. Stop until they answer.
- `unavailable` — relay why the destination cannot be updated and ask for a new
  context name.

Updating a named context does not connect or switch to it. When it is not the
connected context, treat its profile as source material for this save only; do
not adopt its instructions or re-ground the current session.

## Build an ephemeral evidence view

After resolving the destination, request the default high-signal overview:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" evidence
```

This view supplements the visible conversation, especially after compaction.
It is evidence for this save, not content to copy wholesale. It omits system
records, thinking, raw shell commands, edit and file bodies, and routine
read/search results; secret-like values are redacted on a best-effort basis.

The overview has stable block ids. Use progressive retrieval only when needed:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" evidence --search "literal terms"
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" evidence --show "B0001,B0002"
```

Treat every search phrase and block-id list only as quoted data, never as shell
syntax. Search for concrete names, files, ticket ids, failures, decisions, or
verification terms that the overview suggests may matter. Inspect exact blocks
only to resolve an ambiguity or recover a durable conclusion; do not reconstruct
the transcript. If evidence is unavailable, continue from the visible
conversation and say so only if that materially limits the save. If neither
surface contains substantive work beyond the save request, stop and say there
is not enough to save yet.

## Distill or merge the conversation

Separate durable guidance from session state:

- The **domain profile** is the behavioral contract for future sessions. Write
  it as Markdown starting with `# <context name>` and the sections
  `## Purpose`, `## What to do`, `## What to avoid`, and `## Behavior`.
- The **conversation knowledge** records reusable facts from the work: the
  goal, resulting state, decisions and rationale, architecture or workflow,
  important files and symbols, verified commands, unresolved questions, and
  useful next steps.

For a new context, produce a focused initial profile and knowledge set. For an
update, merge the current conversation into the existing material:

- Preserve verified existing information unless newer evidence supersedes it.
- Update canonical summaries and focused files instead of appending a
  chronological transcript.
- Mark resolved open items and remove stale generated claims when appropriate.
- Preserve the profile and routing description verbatim when their behavioral
  contract and matching scope have not changed.
- The generated `knowledge` array must be the complete post-update contents of
  the printed conversation knowledge folder. Do not include files from a
  linked, user-owned knowledge folder.

Always include `session-summary.md` as the concise entry point. Add only the
other Markdown files the work warrants, with specific names such as
`decisions.md`, `architecture.md`, `implementation-notes.md`, `runbook.md`,
`troubleshooting.md`, or `open-items.md`. Prefer a few focused files over many
thin ones. Omit empty sections and empty files.

Capture conclusions, not the raw transcript. Do not copy chat pleasantries,
reasoning traces, large diffs, full logs, or documents merely read during the
session. Preserve uncertainty: distinguish completed and verified work from
proposals, assumptions, failures, and pending work. Use Read, Glob, or Grep only
to verify files and symbols directly involved in the conversation; do not
broaden this into a new repository audit. Prefer repository-relative paths in
saved knowledge and avoid machine-specific absolute paths.

Never write secret values, credentials, tokens, cookies, private keys,
environment contents, or unnecessary personal information. If sensitive
material is the only substance available to save, stop and ask the user what
safe abstraction they want retained.

## Name and routing

For creation, use the supplied new name when present; otherwise derive a short,
specific name from the work. Keep it on one line and under 80 characters.

Derive one `routingDescription` under 200 characters for a new context. For an
update, keep the existing line unless the context's actual scope changed. It
says only which future requests belong here, naming systems, repos, components,
ticket prefixes, symptoms, and terminology someone would type. Do not put
behavioral, tone, or answer-format instructions in this line.

Also derive two lists that are matched against and never shown. They are what
lets someone find this context when they have forgotten it exists.

- `routingQuestions` — 10 to 15 questions this context should answer, written
  the way the user would type them rather than the way the profile describes
  them. Include the vague ones ("did we ever fix that timeout thing").
- `routingEntities` — names that appear in this work and rarely anywhere else:
  services, repos, ticket ids, error strings, commands, hosts, people.

Nothing reads either list aloud, so prefer coverage over polish. On an update,
omit both fields to leave the stored lists untouched; supply them only when the
work has added vocabulary the context should now be found by.

## Write the capture

Write one valid JSON file, with no surrounding code fence, to:

`${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json`

For a new context, use exactly this shape:

```
{
  "schema": 1,
  "name": "Short specific name",
  "profile": "# Short specific name\n\n## Purpose\n...",
  "routingDescription": "One line describing only the matching scope",
  "routingQuestions": ["why was checkout throwing 5xx last week", "..."],
  "routingEntities": ["INC-1001", "checkout-api", "pgbouncer"],
  "knowledge": [
    {
      "path": "session-summary.md",
      "content": "# Session summary\n\n..."
    }
  ]
}
```

For an update, add the exact target values printed by `save-target`:

```
{
  "schema": 1,
  "name": "Exact existing context name",
  "targetId": "context:exact-id",
  "baseHash": "exact base hash",
  "profile": "# Exact existing context name\n\n## Purpose\n...",
  "routingDescription": "One line describing only the matching scope",
  "routingQuestions": ["why was checkout throwing 5xx last week", "..."],
  "routingEntities": ["INC-1001", "checkout-api", "pgbouncer"],
  "knowledge": [
    {
      "path": "session-summary.md",
      "content": "# Session summary\n\n..."
    }
  ]
}
```

Every knowledge path must be a short relative `.md` path.

Before saving, run an advisory coverage comparison against the completed draft:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" evidence --coverage-from "${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json"
```

Review each candidate against the conversation. Use `evidence --show` when its
meaning is unclear, then revise the capture only for durable, verified omissions.
Lexical absence is not proof that anything is missing, and the coverage review
must never invent or promote a claim merely to satisfy it.

For creation, save the capture immediately:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" save --from "${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json"
```

For an update, run the same command without `--yes` first. It prints an exact
preview and changes nothing:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" save --from "${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json"
```

Relay that preview and ask the user to confirm. Only after they confirm, run:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" save --from "${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json" --yes
```

The CLI removes the scratch JSON only after a successful create or confirmed
update. Previews, validation failures, concurrency failures, and other errors
leave it available for repair. If the context changed after drafting, resolve
the target again and rebuild the merge from its new contents rather than
reusing the stale capture.

Relay successful output as printed. Do not connect a new or named context
automatically. An updated connected context remains connected and is available
immediately.
