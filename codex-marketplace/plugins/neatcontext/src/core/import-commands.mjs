// The import command, shared by every host plugin.
//
// Import used to have one outcome: create. That was right exactly once — the
// first time a bundle arrived. Every time after that, the bundle was a newer
// copy of something already here, and creating produced a second context that
// competed with the first during routing while the connected session went on
// reading the stale one.
//
// So import now resolves before it acts, and the interesting part is what it
// refuses to guess. Identity comes from recorded lineage, never from content or
// from a name two people happened to choose alike. Divergence is proven against
// a baseline taken when the copy landed, and an absent baseline counts as
// diverged. Whenever the safe answer cannot be established, the command reports
// and stops rather than writing.
//
// Rendering lives here too. The four hosts differ only in how a slash command
// is spelled, and that arrives as `useCommand`.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  applyImportMerge,
  ContextError,
  importCapturedContext,
  previewCapturedContextUpdate,
  recordImportLineage,
  replaceContextFromBundle,
  resolveImportTarget
} from "./context-store.mjs";
import { MAX_USE_WHEN, putCard, readRouting } from "./routing.mjs";

const normalizeUseWhen = (text) =>
  (text ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_USE_WHEN);

// A routing line the user wrote with `describe` lives only in the routing card,
// never in the manifest — so the import baseline cannot see it, and taking a
// bundle whole would put the bundle's line back without either side noticing it
// had been overruled. It is not treated as divergence, because a routing tweak
// is not knowledge and does not need a merge to resolve; it is simply kept.
//
// Locally authored means the card and the manifest disagree, which is exactly
// what `describe` leaves behind and what an import or save never does.
async function authoredUseWhen(record) {
  const routing = await readRouting().catch(() => null);
  const stored = routing?.cards?.[record.id]?.useWhen ?? "";
  if (stored.length === 0) return null;
  return stored === normalizeUseWhen(record.routingDescription) ? null : stored;
}

function refreshCard(result, authored = null) {
  return putCard(result.record.id, {
    useWhen: authored ?? result.routingDescription,
    source: result.profileText
  }).catch(() => undefined);
}

function changedFiles(lines, label, files) {
  if (files.length === 0) return;
  lines.push(`    ${label}: ${files.join(", ")}`);
}

// What taking the bundle whole would do to the copy here. The same shape the
// save preview prints, for the same reason: the user is about to approve a
// replacement and should see its extent first.
function describeChanges(lines, preview) {
  lines.push(`  Domain profile: ${preview.profileChanged ? "changed" : "unchanged"}`);
  lines.push(`  Routing description: ${preview.routingChanged ? "changed" : "unchanged"}`);
  lines.push(
    `  Knowledge files: ${preview.changes.added.length} added, ` +
      `${preview.changes.updated.length} updated, ${preview.changes.removed.length} removed`
  );
  changedFiles(lines, "Add", preview.changes.added);
  changedFiles(lines, "Update", preview.changes.updated);
  changedFiles(lines, "Remove", preview.changes.removed);
}

// How far the other copy has moved since this one was taken. Only ever stated
// as the pair, because the two numbers are counters on different machines: once
// both sides have been edited they are not versions of each other, and the only
// honest reading is "they are here, you left from there".
//
// Stated only when the baseline actually describes this bundle. A context
// adopted into a lineage it did not come from has a revision recorded against
// somewhere else, and pairing the two numbers would invent a history.
function describeDistance(lines, record, bundle) {
  const theirs = bundle.manifest.revision;
  const taken = record.importedFrom?.revision;
  if (record.importedFrom?.id !== bundle.manifest.id) return;
  if (!Number.isInteger(theirs) || !Number.isInteger(taken)) return;
  lines.push(`  Their revision: ${theirs} (you last took revision ${taken})`);
}

function describeImported(lines, result, source, useCommand) {
  lines.push(`Imported the "${result.record.name}" conversation context.`);
  lines.push(`  Domain profile:   ${result.record.profilePath}`);
  lines.push(
    `  Knowledge folder: ${result.record.knowledgeFolder} ` +
      `(${result.knowledgeFileCount} files)`
  );
  lines.push(`  Local bundle:     ${result.record.directory}`);
  lines.push(`  Connect it with:  ${useCommand} ${result.record.name}`);
  lines.push(`The shared source folder (${source}) was left untouched.`);
}

function describeUpdated(lines, result, source, headline) {
  lines.push(headline);
  lines.push(`  Domain profile:   ${result.record.profilePath}`);
  lines.push(
    `  Knowledge folder: ${result.record.knowledgeFolder} ` +
      `(${result.knowledgeFileCount} files)`
  );
  describeChanges(lines, result);
  lines.push(
    "It is the same context it was, so any session connected to it now reads the " +
      "updated material."
  );
  lines.push(`The shared source folder (${source}) was left untouched.`);
}

// Applying a merge the model has already written. This is the only path that
// takes content from neither side wholesale, so the preview is shown and
// confirmed exactly the way a save update is.
async function runMergedImport({ bundleFolder, mergedFrom, confirmed, consume }) {
  const lines = [];
  let capture;
  try {
    capture = JSON.parse(await readFile(mergedFrom, "utf8"));
  } catch {
    lines.push(`Could not read a valid merged capture JSON file at ${mergedFrom}.`);
    return lines;
  }
  if (capture?.schema !== 1) {
    lines.push("Unsupported merged capture schema. Expected schema 1.");
    return lines;
  }
  if (typeof capture.targetId !== "string" || capture.targetId.length === 0) {
    lines.push(
      "A merged capture must carry the exact targetId and baseHash this import printed."
    );
    return lines;
  }
  if (typeof capture.bundleHash !== "string" || capture.bundleHash.length === 0) {
    lines.push(
      "A merged capture must carry the exact bundleHash this import printed — it is what " +
        "records which version of the bundle was actually merged."
    );
    return lines;
  }

  const preview = await previewCapturedContextUpdate(capture);
  if (!preview.changed) {
    lines.push(`The merge does not change the "${preview.record.name}" context.`);
    return lines;
  }
  if (!confirmed) {
    lines.push(`Merge the bundle into the "${preview.record.name}" context?`);
    describeChanges(lines, preview);
    lines.push("Re-run this import with --yes to apply the merge.");
    return lines;
  }

  const authored = await authoredUseWhen(preview.record);
  const result = await applyImportMerge({ bundleFolder, capture });
  await refreshCard(result, authored);
  // Only once it has landed, and only when asked. A preview must leave the
  // draft where it is, and so must any failure, or a merge the model spent the
  // conversation building would have to be rebuilt from nothing.
  if (consume) await rm(mergedFrom, { force: true }).catch(() => undefined);
  describeUpdated(
    lines,
    result,
    path.resolve(bundleFolder),
    `Merged the bundle into the "${result.record.name}" context.`
  );
  return lines;
}

export async function runImport({
  bundleFolder,
  name = "",
  into = "",
  mergedFrom = "",
  confirmed = false,
  consume = false,
  useCommand
}) {
  const lines = [];
  try {
    if (mergedFrom.trim().length > 0) {
      return (
        await runMergedImport({ bundleFolder, mergedFrom, confirmed, consume })
      ).join("\n");
    }

    // Resolved on the bundle's own identity, never on the name a fork would be
    // given. Asking "what is already here from this bundle?" under a new name
    // answers about the new name, which is nothing, and the duplicate the fork
    // is about to sit beside would go unmentioned.
    const forkName = name.trim();
    const resolved = await resolveImportTarget({ bundleFolder, into });
    const { bundle, record, preview } = resolved;
    const source = bundle.source;

    // An explicit name is the one instruction that overrides the resolution: it
    // says to keep both copies as separate contexts. Honoured, and named as the
    // choice it is, because two contexts about the same subject will compete
    // every time a session routes itself.
    if (forkName.length > 0) {
      const created = await importCapturedContext({ bundleFolder, name: forkName });
      await refreshCard(created);
      // Only worth saying when the two really are copies of one bundle. A name
      // that merely collided is a different context, and forking is the right
      // answer rather than a cost to warn about.
      if (record && resolved.matchedBy === "lineage") {
        lines.push(
          `Note: "${record.name}" is already a copy of this bundle. You now have two ` +
            "separate contexts holding the same material, and both will be considered " +
            "whenever a session routes itself."
        );
      } else if (resolved.matchedBy === "ambiguous") {
        lines.push(
          `Note: ${resolved.candidates.length} contexts here were already copies of this ` +
            `bundle, and this makes ${resolved.candidates.length + 1}. A later import cannot ` +
            'tell which one you mean and will ask, so name it with --into "<name>".'
        );
      }
      describeImported(lines, created, source, useCommand);
      return lines.join("\n");
    }

    if (resolved.action === "create") {
      const created = await importCapturedContext({ bundleFolder });
      await refreshCard(created);
      describeImported(lines, created, source, useCommand);
      return lines.join("\n");
    }

    if (resolved.action === "current") {
      lines.push("Import action: current");
      lines.push(`"${record.name}" already holds everything in this bundle. Nothing to import.`);
      // Adoption is an answer about identity, and it has to survive even when
      // there is no content to move. Left unrecorded, the next bundle from this
      // origin would ask the same question again — and no answer to it could
      // ever fast-forward, because no baseline was ever written down.
      if (resolved.matchedBy === "adopted") {
        await recordImportLineage(record, bundle, { identityOnly: true });
        lines.push(
          `Recorded that "${record.name}" is this bundle's copy, so a later one is ` +
            "recognised without being told again."
        );
      }
      return lines.join("\n");
    }

    // A name in common is not evidence of a common origin, and the two cases
    // want opposite handling, so this is the one outcome that asks. `--into`
    // adopts the local context as this bundle's copy; since no baseline against
    // this bundle exists for it, adopting leads to a merge and never to a
    // replacement.
    // No id in the bundle means no key to recognise it by, now or later. It can
    // still be brought in — as its own context — but it cannot be tied to one
    // already here, so the reconciling answers are not offered rather than
    // offered and then found to be unusable.
    if (resolved.action === "unlinkable") {
      lines.push("Import action: unlinkable");
      lines.push(
        `This bundle carries no context id, so there is no way to establish that ` +
          `"${record.name}" is a copy of it — and no way to record it if there were. ` +
          "Whoever exported it should do so from a current build; a bundle written by " +
          "one carries the id this needs."
      );
      lines.push(
        'It can still be brought in as its own context: re-run with --name "<new name>".'
      );
      return lines.join("\n");
    }

    // Several local contexts already carry this bundle's lineage, which is what
    // forking leaves behind. Any of them could be the one meant, and picking is
    // the user's call rather than the list order's.
    if (resolved.action === "choose" && resolved.matchedBy === "ambiguous") {
      lines.push("Import action: choose");
      lines.push(
        `${resolved.candidates.length} contexts here are copies of this bundle, so there ` +
          "is no single one to update:"
      );
      for (const candidate of resolved.candidates) {
        lines.push(`  ${candidate.name}`);
      }
      lines.push('Name the one you mean with --into "<name>".');
      return lines.join("\n");
    }

    if (resolved.action === "choose") {
      lines.push("Import action: choose");
      lines.push(
        `A context named "${record.name}" is already here, but nothing records that it ` +
          "came from this bundle — it may be the same context imported before lineage " +
          "was tracked, or it may be someone else's context that happens to share the name."
      );
      lines.push("Taking the bundle whole would look like this:");
      describeChanges(lines, preview);
      lines.push("Say which it is:");
      lines.push(`  --into "${record.name}"`);
      lines.push("      the same context — reconcile the bundle into it");
      lines.push('  --name "<new name>"');
      lines.push("      a different context — keep both, side by side");
      return lines.join("\n");
    }

    if (resolved.action === "merge") {
      lines.push("Import action: merge");
      lines.push(
        resolved.matchedBy === "adopted"
          ? `"${record.name}" is being treated as this bundle's copy, and nothing here ` +
              "records what the two once had in common. Taking the bundle whole would " +
              "discard whatever only this copy holds, so the two have to be reconciled first."
          : `"${record.name}" came from this bundle, and both copies have changed since. ` +
              "Taking the bundle whole would discard the work saved here, so the two have " +
              "to be reconciled first."
      );
      describeDistance(lines, record, bundle);
      // Adoption is recorded now rather than at apply time, so the merge that
      // follows can be checked against a target this bundle is known to belong
      // to. Identity only: nothing has been taken from the bundle yet.
      if (resolved.matchedBy === "adopted") {
        await recordImportLineage(record, bundle, { identityOnly: true });
      }
      lines.push(`Context name: ${record.name}`);
      lines.push(`Context id: ${record.id}`);
      lines.push(`Base hash: ${resolved.baseHash}`);
      lines.push(`Bundle hash: ${resolved.bundleHash}`);
      lines.push(`Profile path: ${record.profilePath}`);
      lines.push(`Knowledge folder: ${record.knowledgeFolder}`);
      lines.push(`Bundle profile: ${path.join(source, "profile.md")}`);
      lines.push(`Bundle knowledge: ${path.join(source, "knowledge")}`);
      lines.push(
        "Merge both sides, then apply the result with --merged-from. Carry the context " +
          "id, base hash, and bundle hash into the draft exactly as printed: they are what " +
          "prove the merge is for this context and was built from this bundle."
      );
      return lines.join("\n");
    }

    if (!confirmed) {
      lines.push("Import action: replace");
      lines.push(
        `"${record.name}" came from this bundle and has not been edited here since, so ` +
          "the newer copy can be taken whole."
      );
      describeDistance(lines, record, bundle);
      describeChanges(lines, preview);
      lines.push("Re-run this import with --yes to take it.");
      return lines.join("\n");
    }

    const authored = await authoredUseWhen(record);
    const result = await replaceContextFromBundle({
      bundleFolder,
      targetId: record.id,
      baseHash: resolved.baseHash
    });
    await refreshCard(result, authored);
    if (authored) {
      lines.push(`Kept the routing description you set here: ${authored}`);
    }
    describeUpdated(
      lines,
      result,
      source,
      `Updated the "${result.record.name}" context from the bundle.`
    );
    return lines.join("\n");
  } catch (error) {
    if (error instanceof ContextError) {
      return error.message;
    }
    throw error;
  }
}
