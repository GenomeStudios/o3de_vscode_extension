// ============================================================================
//  Stale compileCommands pruning — the pure rule.
//
//  Removes only PROVABLY dead entries (the file is missing). Never name-matches
//  "n_cc", never guesses at unresolved ${...} variables. Existence is injected so
//  these run without touching disk.
// ============================================================================

import * as assert from "assert";
import { pruneDeadCompileCommands } from "../intellisense/staleSettings";

// ---- Fixture ---------------------------------------------------------------
const present = new Set(["D:/proj/build/windows/compile_commands.json"]);
const exists = (file: string): boolean => present.has(file);

// ---- Tests -----------------------------------------------------------------
suite("pruneDeadCompileCommands", () => {
  test("removes a dead entry — the real gs_play shape (array pointing at a deleted n_cc tree)", () => {
    const result = pruneDeadCompileCommands(["D:/OffLocalDev/gs_play/build/n_cc/compile_commands.json"], exists);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.value, undefined, "all entries dead → remove the key, restoring cpptools' default");
    assert.deepStrictEqual(result.removed, ["D:/OffLocalDev/gs_play/build/n_cc/compile_commands.json"]);
  });

  test("keeps live entries and drops only the dead ones", () => {
    const result = pruneDeadCompileCommands(
      ["D:/proj/build/windows/compile_commands.json", "D:/proj/build/n_cc/compile_commands.json"],
      exists,
    );
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.value, ["D:/proj/build/windows/compile_commands.json"]);
  });

  test("the rule is existence, NOT the name — a live n_cc path is kept", () => {
    present.add("D:/proj/build/n_cc/compile_commands.json");
    try {
      const result = pruneDeadCompileCommands(["D:/proj/build/n_cc/compile_commands.json"], exists);
      assert.strictEqual(result.changed, false);
    } finally {
      present.delete("D:/proj/build/n_cc/compile_commands.json");
    }
  });

  test("accepts cpptools' string form as well as the array form", () => {
    const result = pruneDeadCompileCommands("D:/gone/compile_commands.json", exists);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.value, undefined);
  });

  test("never removes an unresolved ${...} variable — it cannot be proven missing", () => {
    const result = pruneDeadCompileCommands(["${workspaceFolder}/build/n_cc/compile_commands.json"], exists);
    assert.strictEqual(result.changed, false);
  });

  test("leaves cpptools' default [\"\"] untouched", () => {
    assert.strictEqual(pruneDeadCompileCommands([""], exists).changed, false);
  });

  test("an unset setting is a no-op", () => {
    assert.strictEqual(pruneDeadCompileCommands(undefined, exists).changed, false);
  });

  test("a fully live setting is a no-op", () => {
    const result = pruneDeadCompileCommands(["D:/proj/build/windows/compile_commands.json"], exists);
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.removed, []);
  });
});
