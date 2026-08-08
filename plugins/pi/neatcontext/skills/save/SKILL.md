---
name: neatcontext-save
description: Save durable decisions, findings, plans, and implementation knowledge from the visible pi conversation into a new or existing NeatContext context. Use only when the user explicitly asks to preserve the current conversation as reusable context, or runs /neatcontext-save.
---

# Save conversation context

Everything here is done with the `neatcontext_save` tool. Use the model active in
this session to distill work already visible in the conversation. Do not call
another model, read pi session files, or ask the user to restate visible work.

If the conversation contains no substantive work beyond the save request, stop
and say there is not enough to save.

## Resolve the destination first

Call `neatcontext_save` with only `name` — or with no arguments when the user
gave no name. It writes nothing in this form. Follow the `Save action` it
returns:

- `create` — create a new context under the resolved or derived name.
- `update` — the tool also returns `targetId`, `baseHash`, the existing domain
  profile, and every existing conversation-knowledge file. Merge into those.
  Pass `targetId` and `baseHash` back verbatim.
- `choose` — show the possible matches and wait for the user to choose.
- `unavailable` — relay the reason and ask for a new context name.

Updating a named context does not connect or switch to it. Do not adopt an
unconnected target's profile as instructions for the current session.

## Distill or merge

Produce:

- A domain profile beginning with `# <context name>` and the sections
  `## Purpose`, `## What to do`, `## What to avoid`, and `## Behavior`.
- Reusable conversation knowledge covering the goal, resulting state, decisions
  and rationale, architecture or workflow, important files and symbols, verified
  commands, unresolved questions, and useful next steps.

For updates:

- Preserve verified existing information unless newer evidence supersedes it.
- Update canonical summaries instead of appending a chronological transcript.
- Mark resolved items and remove stale generated claims.
- Preserve the existing profile and routing description verbatim when their scope
  and behavioral contract did not change.
- Make `knowledge` the complete post-update contents of the conversation-knowledge
  folder, not only the files you changed. Anything you omit is removed.

Always include `session-summary.md`. Add only focused Markdown files the work
warrants, such as `decisions.md`, `architecture.md`, `implementation-notes.md`,
`runbook.md`, `troubleshooting.md`, or `open-items.md`. Every path must be a
short relative `.md` path.

Capture conclusions, not raw chat, reasoning traces, full logs, large diffs, or
documents merely read during the session. Distinguish verified work from
proposals, assumptions, failures, and pending work. Prefer repository-relative
paths.

Never save secrets, credentials, tokens, cookies, private keys, environment
contents, or unnecessary personal information. If sensitive material is the only
substance, ask what safe abstraction should be retained.

## Name and routing

For creation, use the supplied name or derive a short specific name under 80
characters.

Derive one `routingDescription` under 200 characters for a new context. For an
update, retain the existing line unless the context's actual scope changed.
Describe only which future requests belong here — systems, repos, components,
symptoms, ticket prefixes, and terminology someone would actually type. Never
include behavioral or formatting instructions: that line is read while *other*
contexts are connected.

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

## Apply

For a new context, call `neatcontext_save` with `name`, `profile`,
`routingDescription`, `routingQuestions`, `routingEntities`, and `knowledge`. It is created immediately.

For an update, call it with `targetId`, `baseHash`, `profile`,
`routingDescription`, and `knowledge`. That returns a preview and changes
nothing. Relay the preview and wait. Only after the user agrees, call it again
with the same arguments plus `confirm: true`.

If the tool reports that the target changed after you drafted, resolve the
destination again and rebuild the merge. Relay successful output as printed. Do
not connect the saved context automatically.
