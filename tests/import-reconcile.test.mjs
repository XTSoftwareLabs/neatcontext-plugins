// Importing the same context twice.
//
// The first import is a create and always was. Every import after it is the
// interesting one: the bundle is a newer copy of something already here, and
// the plugin has to work out whether taking it would cost anything before it
// takes it. These protect the four answers — nothing to do, take it whole,
// reconcile first, or ask — and the two things that must never happen: losing
// local work to a replacement, and losing the context's identity to a
// re-create.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const claude = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "claude-code",
  "neatcontext",
  "src",
  "claude"
);

let home;
let serial = 0;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-import-test-"));
  // The few checks that call the store directly read the same home the CLI does.
  process.env.NEATCONTEXT_HOME = home;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { recursive: true, force: true });
});

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(claude, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: "",
        NEATCONTEXT_HOST_KEY: "",
        CLAUDE_PID: "",
        NEATCONTEXT_HOME: home
      }
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

function capture(overrides = {}) {
  return {
    schema: 1,
    name: "Team Checkout",
    profile:
      "# Team Checkout\n\n## Purpose\nCheckout recovery.\n\n" +
      "## What to do\nUse the recorded decisions.\n\n" +
      "## What to avoid\nDo not invent deployment state.\n\n" +
      "## Behavior\nSeparate verified facts from open work.",
    routingDescription: "Checkout recovery, payment retries, PAY-* tickets",
    knowledge: [{ path: "session-summary.md", content: "# Session summary\n\nOriginal work." }],
    ...overrides
  };
}

async function save(spec = capture(), { yes = false } = {}) {
  const file = path.join(home, `capture-${serial++}.json`);
  await writeFile(file, JSON.stringify(spec));
  return cli("save", "--from", file, ...(yes ? ["--yes"] : []));
}

const field = (output, label) => new RegExp(`^${label}: (.+)$`, "m").exec(output)?.[1];
const localBundle = (output) => /Local bundle:\s+(.+)/.exec(output)?.[1];

const manifestAt = async (directory) =>
  JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));

// A context saved here, exported, then deleted — leaving only the bundle a
// teammate would have handed over.
async function sharedBundle(spec = capture()) {
  const saved = await save(spec);
  const directory = /Context folder:\s+(.+)/.exec(saved)?.[1];
  const destination = path.join(home, `share-${serial++}`);
  await cli("export", spec.name, "--to", destination);
  await cli("delete", spec.name, "--yes");
  return path.join(destination, path.basename(directory));
}

// What a teammate doing more work and re-sharing looks like from this side.
async function upstreamUpdate(bundle, { profileNote, file }) {
  const manifest = await manifestAt(bundle);
  manifest.revision += 1;
  manifest.updatedAt = new Date().toISOString();
  await writeFile(path.join(bundle, "context.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (profileNote) {
    const profilePath = path.join(bundle, "profile.md");
    await writeFile(profilePath, `${await readFile(profilePath, "utf8")}\n${profileNote}\n`);
  }
  if (file) await writeFile(path.join(bundle, "knowledge", file.path), file.content);
}

// Saving local work into the imported copy, the way a session would.
async function localWork(name, knowledge) {
  const target = await cli("save-target", name);
  return save(
    capture({
      name,
      targetId: field(target, "Context id"),
      baseHash: field(target, "Base hash"),
      knowledge: [{ path: "session-summary.md", content: knowledge }]
    }),
    { yes: true }
  );
}

describe("importing a bundle this machine already has", () => {
  it("records where a copy came from and recognises the same bundle again", async () => {
    const bundle = await sharedBundle();
    const imported = await cli("import", "--from", bundle);
    assert.match(imported, /Imported the "Team Checkout" conversation context/);

    const lineage = (await manifestAt(localBundle(imported))).importedFrom;
    assert.equal(lineage.id, (await manifestAt(bundle)).id);
    assert.equal(lineage.revision, 1);
    assert.equal(typeof lineage.fingerprint, "string");
    assert.equal(typeof lineage.bundleFingerprint, "string");

    const again = await cli("import", "--from", bundle);
    assert.match(again, /Import action: current/);
    assert.match(again, /already holds everything in this bundle/);
  });

  it("previews a newer copy and takes it in place, keeping the same context", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    const before = await manifestAt(directory);
    await cli("use", "Team Checkout");

    await upstreamUpdate(bundle, {
      profileNote: "Upstream: retries are capped.",
      file: { path: "runbook.md", content: "# Runbook\n\nRestart the worker.\n" }
    });

    const preview = await cli("import", "--from", bundle);
    assert.match(preview, /Import action: replace/);
    assert.match(preview, /has not been edited here since/);
    assert.match(preview, /Their revision: 2 \(you last took revision 1\)/);
    assert.match(preview, /Add: runbook\.md/);
    assert.match(preview, /Re-run this import with --yes/);
    // A preview writes nothing.
    assert.deepEqual(await manifestAt(directory), before);

    const applied = await cli("import", "--from", bundle, "--yes");
    assert.match(applied, /Updated the "Team Checkout" context from the bundle/);

    const after = await manifestAt(directory);
    assert.equal(after.id, before.id, "a replacement must not mint a new context id");
    assert.equal(after.updatedFrom, "import");
    assert.equal(after.importedFrom.revision, 2);
    assert.match(
      await readFile(path.join(directory, "knowledge", "runbook.md"), "utf8"),
      /Restart the worker/
    );
    // Same context, so the session that was connected still is.
    assert.match(await cli("status"), /Team Checkout/);
    assert.match(await cli("list"), /Team Checkout\s+\(connected\)/);
  });

  it("offers a merge instead of a replacement once local work exists", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    await localWork("Team Checkout", "# Session summary\n\nLocal work happened here.");
    await upstreamUpdate(bundle, { profileNote: "Upstream: provider raised the limit." });

    const resolved = await cli("import", "--from", bundle);
    assert.match(resolved, /Import action: merge/);
    assert.match(resolved, /both copies have changed since/);
    assert.match(resolved, /would discard the work saved here/);
    assert.equal(field(resolved, "Context id"), (await manifestAt(directory)).id);
    assert.equal(field(resolved, "Bundle profile"), path.join(bundle, "profile.md"));
    assert.doesNotMatch(resolved, /--yes/, "a merge is never offered as a one-key overwrite");
    // Nothing was taken: the local work is still the only thing there.
    assert.match(
      await readFile(path.join(directory, "knowledge", "session-summary.md"), "utf8"),
      /Local work happened here/
    );
  });

  it("applies a merged capture, then treats that bundle as consumed", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    await localWork("Team Checkout", "# Session summary\n\nLocal work happened here.");
    await upstreamUpdate(bundle, {
      profileNote: "Upstream: provider raised the limit.",
      file: { path: "runbook.md", content: "# Runbook\n\nRestart the worker.\n" }
    });
    const resolved = await cli("import", "--from", bundle);

    const merged = path.join(home, `merged-${serial++}.json`);
    await writeFile(
      merged,
      JSON.stringify({
        schema: 1,
        name: field(resolved, "Context name"),
        targetId: field(resolved, "Context id"),
        baseHash: field(resolved, "Base hash"),
        bundleHash: field(resolved, "Bundle hash"),
        profile: capture().profile + "\n\nBoth: retries capped and the limit was raised.",
        routingDescription: "Checkout recovery, payment retries, PAY-* tickets",
        knowledge: [
          { path: "session-summary.md", content: "# Session summary\n\nBoth sides, reconciled." },
          { path: "runbook.md", content: "# Runbook\n\nRestart the worker.\n" }
        ]
      })
    );

    const preview = await cli("import", "--from", bundle, "--merged-from", merged);
    assert.match(preview, /Merge the bundle into the "Team Checkout" context\?/);
    assert.match(preview, /Re-run this import with --yes/);
    assert.match(
      await readFile(path.join(directory, "knowledge", "session-summary.md"), "utf8"),
      /Local work happened here/,
      "a merge preview must not write"
    );
    assert.ok(await readFile(merged, "utf8"), "a preview must leave the draft for repair");

    const applied = await cli(
      "import", "--from", bundle, "--merged-from", merged, "--yes", "--consume"
    );
    assert.match(applied, /Merged the bundle into the "Team Checkout" context\./);
    assert.match(
      await readFile(path.join(directory, "knowledge", "session-summary.md"), "utf8"),
      /Both sides, reconciled/
    );
    await assert.rejects(() => readFile(merged, "utf8"), "a confirmed merge consumes the draft");

    // The point of re-stamping lineage: the same divergence is not re-offered
    // against a stale baseline every time the bundle is seen again.
    assert.match(await cli("import", "--from", bundle), /Import action: current/);
  });

  it("rejects a merged capture it cannot trust, without touching the context", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    await localWork("Team Checkout", "# Session summary\n\nLocal work happened here.");
    await upstreamUpdate(bundle, { profileNote: "Upstream: provider raised the limit." });
    const resolved = await cli("import", "--from", bundle);
    const before = await manifestAt(directory);

    const draft = async (contents) => {
      const file = path.join(home, `bad-merge-${serial++}.json`);
      await writeFile(file, contents);
      return cli("import", "--from", bundle, "--merged-from", file, "--yes", "--consume");
    };

    assert.match(
      await cli("import", "--from", bundle, "--merged-from", path.join(home, "not-written.json")),
      /Could not read a valid merged capture JSON file/
    );
    assert.match(await draft("{not json"), /Could not read a valid merged capture JSON file/);
    assert.match(
      await draft(JSON.stringify({ schema: 9, name: "Team Checkout" })),
      /Unsupported merged capture schema\. Expected schema 1\./
    );
    // A merge without a target is a create wearing the wrong hat: it would make
    // the duplicate the whole command exists to avoid.
    assert.match(
      await draft(JSON.stringify({ schema: 1, name: "Team Checkout" })),
      /must carry the exact targetId and baseHash this import printed/
    );

    const merged = (overrides = {}) => ({
      schema: 1,
      name: field(resolved, "Context name"),
      targetId: field(resolved, "Context id"),
      baseHash: field(resolved, "Base hash"),
      bundleHash: field(resolved, "Bundle hash"),
      profile: capture().profile + "\n\nReconciled.",
      routingDescription: before.routingDescription,
      knowledge: [{ path: "session-summary.md", content: "# Session summary\n\nBoth sides.\n" }],
      ...overrides
    });

    // Which bundle version was merged is not recoverable from the draft itself,
    // so a draft that does not say cannot be trusted to have merged this one.
    assert.match(
      await draft(JSON.stringify(merged({ bundleHash: undefined }))),
      /must carry the exact bundleHash this import printed/
    );

    // Upstream moving between drafting and applying is the case that silently
    // loses their late work: the draft never saw it, and stamping the newer
    // fingerprint would mark it as taken.
    assert.match(
      await draft(JSON.stringify(merged({ bundleHash: "0".repeat(64) }))),
      /bundle changed while this merge was being prepared/
    );

    // A capture is only proof that it was built against some local context.
    // Being addressed to one this bundle has no claim on is the case that would
    // overwrite an unrelated context and stamp this lineage over its own.
    await save(
      capture({
        name: "Unrelated Context",
        profile: "# Unrelated Context\n\n## Purpose\nSomething else entirely."
      })
    );
    const other = await cli("save-target", "Unrelated Context");
    assert.match(
      await draft(
        JSON.stringify(
          merged({
            name: "Unrelated Context",
            targetId: field(other, "Context id"),
            baseHash: field(other, "Base hash")
          })
        )
      ),
      /not recorded as the copy this bundle belongs to/
    );

    // A capture that reproduces what is already stored changes nothing, and is
    // reported rather than written as a no-op revision.
    const unchanged = await draft(
      JSON.stringify(
        merged({
          profile: await readFile(path.join(directory, "profile.md"), "utf8"),
          knowledge: [
            {
              path: "session-summary.md",
              content: await readFile(
                path.join(directory, "knowledge", "session-summary.md"),
                "utf8"
              )
            }
          ]
        })
      )
    );
    assert.match(unchanged, /The merge does not change the "Team Checkout" context\./);

    assert.deepEqual(await manifestAt(directory), before, "no rejected draft may write");
  });

  it("keeps matching after the other side renames, and keeps the local name", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));

    const manifest = await manifestAt(bundle);
    manifest.name = "Checkout Recovery (renamed upstream)";
    manifest.revision += 1;
    await writeFile(path.join(bundle, "context.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await upstreamUpdate(bundle, { profileNote: "Upstream: renamed and revised." });

    assert.match(await cli("import", "--from", bundle), /Import action: replace/);
    await cli("import", "--from", bundle, "--yes");
    assert.equal(
      (await manifestAt(directory)).name,
      "Team Checkout",
      "a rename upstream must not rename the copy here"
    );
  });
});

describe("importing a bundle whose identity cannot be proved", () => {
  // A bundle from somewhere else that happens to use a name already taken.
  async function strangerBundle() {
    const bundle = await sharedBundle();
    await cli("import", "--from", bundle);
    const stranger = path.join(home, `stranger-${serial++}`);
    await cp(bundle, stranger, { recursive: true });
    const manifest = await manifestAt(stranger);
    manifest.id = `context:someone-else-${serial++}00000000`;
    await writeFile(
      path.join(stranger, "context.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    await writeFile(
      path.join(stranger, "profile.md"),
      "# Team Checkout\n\n## Purpose\nA different team's checkout work.\n"
    );
    return stranger;
  }

  it("asks which context it is rather than guessing", async () => {
    const stranger = await strangerBundle();
    const resolved = await cli("import", "--from", stranger);
    assert.match(resolved, /Import action: choose/);
    assert.match(resolved, /nothing records that it came from this bundle/);
    assert.match(resolved, /--into "Team Checkout"/);
    assert.match(resolved, /--name "<new name>"/);
    assert.doesNotMatch(resolved, /Re-run this import with --yes/);
  });

  it("refuses to adopt a context that is not here", async () => {
    const stranger = await strangerBundle();
    assert.match(
      await cli("import", "--from", stranger, "--into", "Not A Context"),
      /No context here is named "Not A Context"/
    );
  });

  it("imports a bundle carrying no id, and records no lineage for it", async () => {
    const bundle = await sharedBundle();
    const manifest = await manifestAt(bundle);
    delete manifest.id;
    await writeFile(path.join(bundle, "context.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const imported = await cli("import", "--from", bundle);
    assert.match(imported, /Imported the "Team Checkout" conversation context/);
    assert.equal(
      (await manifestAt(localBundle(imported))).importedFrom,
      undefined,
      "there is nothing to key a later import on, so nothing is claimed"
    );
  });

  it("reconciles rather than overwrites when a context is adopted into a lineage", async () => {
    const stranger = await strangerBundle();
    const adopted = await cli("import", "--from", stranger, "--into", "Team Checkout");
    // The local copy is untouched since its own import, but that baseline was
    // left by a different origin and cannot license replacing it.
    assert.match(adopted, /Import action: merge/);
    assert.match(adopted, /is being treated as this bundle's copy/);
    assert.doesNotMatch(adopted, /Their revision/, "no shared history to count from");
  });

  it("forks on an explicit name, without calling a different context a duplicate", async () => {
    const stranger = await strangerBundle();
    const forked = await cli("import", "--from", stranger, "--name", "Their Team Checkout");
    assert.match(forked, /Imported the "Their Team Checkout" conversation context/);
    assert.doesNotMatch(
      forked,
      /already a copy of this bundle/,
      "a name collision between unrelated contexts is not a duplicate"
    );

    const list = await cli("list");
    assert.match(list, /Team Checkout/);
    assert.match(list, /Their Team Checkout/);
  });
});

describe("importing a bundle a second time under a new name", () => {
  it("keeps both copies and says what that costs", async () => {
    const bundle = await sharedBundle();
    await cli("import", "--from", bundle);

    const forked = await cli("import", "--from", bundle, "--name", "Team Checkout Fork");
    assert.match(forked, /Imported the "Team Checkout Fork" conversation context/);
    assert.match(forked, /"Team Checkout" is already a copy of this bundle/);
    assert.match(forked, /both will be considered whenever a session routes itself/);
    assert.match(await cli("list"), /Team Checkout Fork/);
  });
});

// Three ways a copy's identity or its local intent can be lost quietly. None of
// them announce themselves: each looks like an ordinary import until something
// the user set is gone, or the wrong context is the one that moved.
describe("what import must not overwrite or forget", () => {
  it("will not choose between two copies of one bundle", async () => {
    const bundle = await sharedBundle();
    await cli("import", "--from", bundle);
    // Forking leaves two contexts carrying one lineage id. The fork sorts first,
    // so picking by list order would silently target it instead of the original.
    const forked = await cli("import", "--from", bundle, "--name", "AAA Fork");
    assert.match(forked, /"Team Checkout" is already a copy of this bundle/);
    // Forking again, now that it is already ambiguous, says so instead.
    assert.match(
      await cli("import", "--from", bundle, "--name", "ZZZ Fork"),
      /2 contexts here were already copies of this bundle, and this makes 3/
    );
    await cli("delete", "ZZZ Fork", "--yes");
    await upstreamUpdate(bundle, { profileNote: "Upstream: something new." });

    const ambiguous = await cli("import", "--from", bundle);
    assert.match(ambiguous, /Import action: choose/);
    assert.match(ambiguous, /2 contexts here are copies of this bundle/);
    assert.match(ambiguous, /AAA Fork/);
    assert.match(ambiguous, /Team Checkout/);
    assert.doesNotMatch(ambiguous, /Import action: replace/);

    // Named, it resolves to exactly the one asked for.
    assert.match(
      await cli("import", "--from", bundle, "--into", "Team Checkout"),
      /Import action: replace/
    );
  });

  it("records an adoption even when there is nothing to import", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    // Strip the lineage, leaving a copy that matches the bundle byte for byte
    // but cannot prove where it came from — a context imported before lineage.
    const manifest = await manifestAt(directory);
    delete manifest.importedFrom;
    await writeFile(
      path.join(directory, "context.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    assert.match(await cli("import", "--from", bundle), /Import action: choose/);

    const adopted = await cli("import", "--from", bundle, "--into", "Team Checkout");
    assert.match(adopted, /Import action: current/);
    assert.match(adopted, /Recorded that "Team Checkout" is this bundle's copy/);
    assert.equal((await manifestAt(directory)).importedFrom.id, (await manifestAt(bundle)).id);

    // The assertion was needed once. A later bundle is recognised on its own,
    // and — since adoption claimed identity but never claimed to have taken the
    // contents — it reconciles rather than overwriting.
    await upstreamUpdate(bundle, { profileNote: "Upstream: later work." });
    const next = await cli("import", "--from", bundle);
    assert.match(next, /Import action: merge/);
    assert.doesNotMatch(next, /Import action: choose/);
  });

  it("keeps a routing description written here when taking a newer copy", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    const mine = "Only the checkout retry work, not the payment provider migration";
    await cli("describe", "Team Checkout", "--use-when", mine);
    await upstreamUpdate(bundle, { profileNote: "Upstream: retries are capped." });

    // `describe` writes to the routing card and never to the manifest, so this
    // is deliberately still a fast-forward rather than a merge.
    const applied = await cli("import", "--from", bundle, "--yes");
    assert.match(applied, /Updated the "Team Checkout" context from the bundle/);
    assert.match(applied, new RegExp(`Kept the routing description you set here: ${mine}`));

    const routing = JSON.parse(await readFile(path.join(home, "plugin-routing.json"), "utf8"));
    assert.equal(
      routing.cards[(await manifestAt(directory)).id].useWhen,
      mine,
      "the line the user wrote must outlive the bundle's"
    );
  });
});

// `--into` names a context, and "which one" and "this is the one" are different
// claims. So is a bundle that can be recognised again versus one that cannot.
// Each of these is a way the command could answer confidently and be wrong.
describe("what naming a context with --into does and does not assert", () => {
  it("selects among copies without discarding the baseline of the one chosen", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    await cli("import", "--from", bundle, "--name", "AAA Fork");
    const earned = (await manifestAt(directory)).importedFrom;
    assert.equal(typeof earned.fingerprint, "string");

    // Picking the original out of two copies is disambiguation, not a fresh
    // claim about where it came from — it already knows.
    assert.match(
      await cli("import", "--from", bundle, "--into", "Team Checkout"),
      /Import action: current/
    );
    assert.deepEqual(
      (await manifestAt(directory)).importedFrom,
      earned,
      "selecting a copy must not restamp what it already proved"
    );

    // And because the baseline survived, an untouched copy still qualifies for
    // the fast-forward rather than being pushed into a merge.
    await upstreamUpdate(bundle, { profileNote: "Upstream: later work." });
    assert.match(
      await cli("import", "--from", bundle, "--into", "Team Checkout"),
      /Import action: replace/
    );
  });

  it("can apply a merge into the very context the bundle was exported from", async () => {
    // No import here at all: this context *is* the bundle's origin, so it has
    // no importedFrom of its own and is recognised by id alone.
    const { output } = { output: await save() };
    const directory = /Context folder:\s+(.+)/.exec(output)[1];
    const destination = path.join(home, `own-export-${serial++}`);
    await cli("export", "Team Checkout", "--to", destination);
    const bundle = path.join(destination, path.basename(directory));

    await localWork("Team Checkout", "# Session summary\n\nLocal work after exporting.");
    await upstreamUpdate(bundle, { profileNote: "Upstream: edited the shared copy." });

    const resolved = await cli("import", "--from", bundle);
    assert.match(resolved, /Import action: merge/);

    const merged = path.join(home, `own-merge-${serial++}.json`);
    await writeFile(
      merged,
      JSON.stringify({
        schema: 1,
        name: field(resolved, "Context name"),
        targetId: field(resolved, "Context id"),
        baseHash: field(resolved, "Base hash"),
        bundleHash: field(resolved, "Bundle hash"),
        profile: capture().profile + "\n\nReconciled with the exported copy.",
        routingDescription: capture().routingDescription,
        knowledge: [{ path: "session-summary.md", content: "# Session summary\n\nBoth.\n" }]
      })
    );
    // The merge the command offered has to be one the command will accept.
    assert.match(
      await cli("import", "--from", bundle, "--merged-from", merged, "--yes", "--consume"),
      /Merged the bundle into the "Team Checkout" context\./
    );
    assert.equal((await manifestAt(directory)).importedFrom.id, (await manifestAt(bundle)).id);
  });

  it("offers no reconciliation for a bundle that carries no identity", async () => {
    const bundle = await sharedBundle();
    await cli("import", "--from", bundle);
    const manifest = await manifestAt(bundle);
    delete manifest.id;
    await writeFile(path.join(bundle, "context.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // Nothing can be recorded about such a bundle, so `current` and `merge`
    // would both be answers the command could not keep.
    for (const args of [[], ["--into", "Team Checkout"]]) {
      const resolved = await cli("import", "--from", bundle, ...args);
      assert.match(resolved, /Import action: unlinkable/);
      assert.match(resolved, /carries no context id/);
      assert.match(resolved, /--name "<new name>"/);
      assert.doesNotMatch(resolved, /Import action: (current|merge|replace|choose)/);
    }

    // Forking is still open, and is the only thing this bundle can honestly do.
    assert.match(
      await cli("import", "--from", bundle, "--name", "Anonymous Bundle"),
      /Imported the "Anonymous Bundle" conversation context/
    );
  });
});

// Two paths the command line cannot stage: a target deleted between resolving
// an import and applying it, and a lineage stamp that fails after the import
// has already landed. Both are reached directly, because what they protect is
// only visible at the seam.
describe("what import does when the ground moves under it", () => {
  it("refuses to replace a context that has since been deleted", async () => {
    const { replaceContextFromBundle, ContextError } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    const bundle = await sharedBundle();
    await assert.rejects(
      () =>
        replaceContextFromBundle({
          bundleFolder: bundle,
          targetId: "context:deleted-while-importing",
          baseHash: "irrelevant"
        }),
      (error) =>
        error instanceof ContextError &&
        /no longer exists/.test(error.message)
    );
  });

  it("refuses to apply a merge whose target has since been deleted", async () => {
    const { applyImportMerge, ContextError } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    const bundle = await sharedBundle();
    await assert.rejects(
      () =>
        applyImportMerge({
          bundleFolder: bundle,
          capture: { schema: 1, targetId: "context:deleted-while-merging", baseHash: "x" }
        }),
      (error) => error instanceof ContextError && /no longer exists/.test(error.message)
    );
  });

  it("keeps an imported context when its lineage stamp cannot be written", async () => {
    const { readImportBundle, recordImportLineage } = await import(
      "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
    );
    const bundle = await readImportBundle(await sharedBundle());
    // A record whose directory holds no manifest to patch.
    const record = {
      id: "context:no-manifest-here",
      name: "No Manifest",
      directory: path.join(home, `vanished-${serial++}`),
      knowledgeFolder: path.join(home, "missing-knowledge"),
      knowledgeManaged: true,
      profilePath: path.join(home, "missing-profile.md"),
      routingDescription: "",
      extensions: [],
      capturedFrom: "conversation",
      createdAt: null,
      updatedAt: null,
      revision: 1
    };
    assert.equal(
      await recordImportLineage(record, bundle),
      record,
      "the import survives; only the bookkeeping is lost"
    );
  });
});

describe("what a bundle carries out of this machine", () => {
  it("leaves local lineage behind when exporting an imported context", async () => {
    const bundle = await sharedBundle();
    const directory = localBundle(await cli("import", "--from", bundle));
    assert.ok((await manifestAt(directory)).importedFrom);

    const destination = path.join(home, `re-export-${serial++}`);
    await cli("export", "Team Checkout", "--to", destination);
    const reExported = path.join(destination, path.basename(directory));
    assert.equal(
      (await manifestAt(reExported)).importedFrom,
      undefined,
      "lineage describes this machine's copy and means nothing to a recipient"
    );
  });
});
