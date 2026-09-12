// ============================================================================
//  Source-engine selection — the F12 / step-through destination.
//
//  REGRESSION GUARD. Selection used to match on the folder NAME
//  ("Engine (source): …"), which is what our Setup Workspace command writes. Any
//  hand-built or pre-convention workspace names the folder plainly, so the check
//  failed, the engine redirect silently no-opped, and F12 landed in a prebuilt
//  SDK engine that ships no .cpp at all. These tests encode the REQUIREMENT
//  (a non-SDK engine.json) rather than the naming convention.
//
//  Fixtures are real folders so readEngine hits disk exactly as it does at runtime.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FolderCandidate,
  orderEngineRootsSourceFirst,
  pickSourceEngineFolder,
  sourceEngineFolders,
} from "../build/workspaceFolders";

// ---- Fixture ---------------------------------------------------------------
let root: string;

/** A workspace folder carrying an engine.json. `sdk` mirrors a prebuilt SDK install. */
function engineFolder(name: string, sdk: boolean): FolderCandidate {
  const dir = path.join(root, name.replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "engine.json"),
    JSON.stringify({ engine_name: name, version: "2.7.0", ...(sdk ? { sdk_engine: true } : {}) }),
  );
  return { path: dir, name };
}

/** A workspace folder with no engine.json — a project or gem folder. */
function plainFolder(name: string): FolderCandidate {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { path: dir, name };
}

// ---- Tests -----------------------------------------------------------------
suite("pickSourceEngineFolder (structural, not name-based)", () => {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-srcengine-"));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("picks a PLAINLY named source engine — the real gs_play workspace shape", () => {
    // gs_play.code-workspace names its folders: gs_play, gs_play_gems,
    // o3de_sourcedev, GS_Play_Engine. None carries the "Engine (source):" prefix.
    const folders = [
      plainFolder("gs_play"),
      plainFolder("gs_play_gems"),
      engineFolder("o3de_sourcedev", false),
      engineFolder("GS_Play_Engine", true),
    ];
    const picked = pickSourceEngineFolder(folders);
    assert.strictEqual(picked?.name, "o3de_sourcedev");
  });

  test("never picks an SDK engine — it ships headers only, so F12 would dead-end", () => {
    const folders = [plainFolder("proj"), engineFolder("GS_Play_Engine", true)];
    assert.strictEqual(pickSourceEngineFolder(folders), undefined);
  });

  test("prefers the source engine when an SDK engine is also present", () => {
    const folders = [engineFolder("GS_Play_Engine", true), engineFolder("o3de_sourcedev", false)];
    assert.strictEqual(pickSourceEngineFolder(folders)?.name, "o3de_sourcedev");
  });

  test("the \"Engine (source):\" name only breaks ties between source engines", () => {
    const folders = [
      engineFolder("o3de_sourcedev", false),
      engineFolder("Engine (source): O3DEEditor", false),
    ];
    assert.strictEqual(pickSourceEngineFolder(folders)?.name, "Engine (source): O3DEEditor");
  });

  test("folders without an engine.json are ignored", () => {
    const folders = [plainFolder("gs_play"), plainFolder("gs_play_gems")];
    assert.strictEqual(pickSourceEngineFolder(folders), undefined);
  });

  test("no folders at all → undefined", () => {
    assert.strictEqual(pickSourceEngineFolder([]), undefined);
  });
});

suite("sourceEngineFolders (the single source of truth)", () => {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-srclist-"));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("lists every source engine, named first, and never an SDK or a plain folder", () => {
    const folders = [
      plainFolder("gs_play"),
      engineFolder("o3de_sourcedev", false),
      engineFolder("GS_Play_Engine", true),
      engineFolder("Engine (source): O3DEEditor", false),
    ];
    assert.deepStrictEqual(
      sourceEngineFolders(folders).map((f) => f.name),
      ["Engine (source): O3DEEditor", "o3de_sourcedev"],
    );
  });

  test("pickSourceEngineFolder is exactly the first of sourceEngineFolders", () => {
    const folders = [engineFolder("o3de_sourcedev", false), engineFolder("Engine (source): O3DEEditor", false)];
    assert.strictEqual(pickSourceEngineFolder(folders)?.name, sourceEngineFolders(folders)[0].name);
  });
});

suite("orderEngineRootsSourceFirst", () => {
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-srcorder-"));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("source engines rank ahead of SDK engines regardless of folder order", () => {
    const sdk = engineFolder("GS_Play_Engine", true);
    const source = engineFolder("o3de_sourcedev", false);
    const ordered = orderEngineRootsSourceFirst([sdk, source]);
    assert.deepStrictEqual(
      ordered.map((f) => f.name),
      ["o3de_sourcedev", "GS_Play_Engine"],
    );
  });

  test("a named source engine ranks ahead of a plainly named one", () => {
    const plain = engineFolder("o3de_sourcedev", false);
    const named = engineFolder("Engine (source): O3DEEditor", false);
    const ordered = orderEngineRootsSourceFirst([plain, named]);
    assert.strictEqual(ordered[0].name, "Engine (source): O3DEEditor");
  });
});
