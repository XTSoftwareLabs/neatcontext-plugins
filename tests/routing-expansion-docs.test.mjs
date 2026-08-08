// Every host has to ask for the matching material, not just the one somebody
// happened to edit.
//
// The storage for `routingQuestions` and `routingEntities` is shared core, so it
// arrived everywhere at once. The instruction that fills them is not: each host
// carries its own save document, and a context saved from a host whose document
// forgot to ask is stored with nothing to match against and is quietly harder
// to find than the same work saved from another host.
//
// This is the same shape of bug the command sweep in plugin-commands.test.mjs
// exists for: one host's omission hiding in four other hosts' correctness.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The document each host's save flow actually reads.
const SAVE_DOCUMENTS = {
  "claude-code": "plugins/claude-code/neatcontext/commands/save.md",
  copilot: "plugins/copilot/neatcontext/commands/save.md",
  "kimi-code": "plugins/kimi-code/neatcontext/skills/save/SKILL.md",
  codex: "codex-marketplace/plugins/neatcontext/skills/save/SKILL.md",
  pi: "plugins/pi/neatcontext/skills/save/SKILL.md"
};

describe("every host asks for the matching material", () => {
  for (const [host, file] of Object.entries(SAVE_DOCUMENTS)) {
    it(`${host} asks for both lists`, async () => {
      const text = await readFile(path.join(root, file), "utf8");
      assert.ok(text.includes("routingQuestions"), `${file} never mentions routingQuestions`);
      assert.ok(text.includes("routingEntities"), `${file} never mentions routingEntities`);
    });

    it(`${host} says the lists are never shown`, async () => {
      // Without this the model writes them as prose for a reader, which is a
      // different and much worse list than one written to be matched against.
      const text = await readFile(path.join(root, file), "utf8");
      assert.match(text, /never shown|matched against and never shown|Matched against, never shown/i);
    });

    it(`${host} says the lists travel and must stay portable`, async () => {
      // The lists go into the bundle, and the bundle is meant to be handed to a
      // teammate intact. A host that asks for hostnames or people gets a
      // context that is worse to share than the work it came from.
      const text = await readFile(path.join(root, file), "utf8");
      assert.match(text, /travels? with the context|travel with the context/i);
      assert.match(text, /absolute paths/i);
      assert.match(text, /usernames|personal names/i);
    });

    it(`${host} never asks for hostnames or people`, async () => {
      // The wording this replaced did, which is how machine- and person-
      // specific terms would have reached a shared bundle.
      const text = await readFile(path.join(root, file), "utf8");
      assert.ok(!/error strings, commands, hosts/i.test(text), `${file} still asks for hosts`);
      assert.ok(!/commands, hosts, people/i.test(text), `${file} still asks for people`);
    });

    it(`${host} says omitting them leaves stored lists alone`, async () => {
      // The rule that stops a host from wiping what another host wrote.
      const text = await readFile(path.join(root, file), "utf8");
      assert.match(text, /omit both|Omit on an update|leave the stored list/i);
    });
  }
});

describe("the pi save tool", () => {
  it("accepts both lists as arrays", async () => {
    // pi is the one host that takes a save as tool arguments rather than a
    // capture file, so its schema has to carry the fields itself.
    const text = await readFile(
      path.join(root, "plugins", "pi", "neatcontext", "extensions", "neatcontext.js"),
      "utf8"
    );
    assert.match(text, /routingQuestions: \{\s*type: "array"/);
    assert.match(text, /routingEntities: \{\s*type: "array"/);
  });
});
