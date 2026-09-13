// ============================================================================
//  Project → engine resolution — path-dominant first (user/project.json
//  engine_path), then the directory-first name solver for legacy records.
//
//  Fixtures are real folders under a temp O3DE_HOME so readManifest/readEngine
//  hit disk exactly as they do at runtime.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveProjectEngine, setWorkspaceEngineRoots } from "../o3de/discovery";
import { O3deProject, readProject } from "../o3de/identity";

// ---- Fixture -----------------------------------------------------------------
let home: string;
let root: string;

function engineDir(folder: string, json: Record<string, unknown>): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "engine.json"), JSON.stringify(json));
  return dir;
}

function writeManifest(engines: string[], enginesPath: Record<string, string>): void {
  fs.writeFileSync(
    path.join(home, "o3de_manifest.json"),
    JSON.stringify({ engines, engines_path: enginesPath, projects: [], external_subdirectories: [] }),
  );
}

function project(engine?: string, enginePath?: string): O3deProject {
  return {
    projectName: "EngineSource2",
    engine,
    enginePath,
    externalSubdirectories: [],
    gemNames: [],
    path: path.join(root, "EngineSource2"),
  };
}

// ---- Tests -------------------------------------------------------------------
suite("resolveProjectEngine (directory-first)", () => {
  let previousHome: string | undefined;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-resolve-"));
    home = path.join(root, ".o3de");
    fs.mkdirSync(home, { recursive: true });
    previousHome = process.env["O3DE_HOME"];
    process.env["O3DE_HOME"] = home;
    setWorkspaceEngineRoots(() => []);
  });

  teardown(() => {
    if (previousHome === undefined) {
      delete process.env["O3DE_HOME"];
    } else {
      process.env["O3DE_HOME"] = previousHome;
    }
    setWorkspaceEngineRoots(() => []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("resolves a generic engine name missing from engines_path", () => {
    const editor = engineDir("O3DEEditor", { engine_name: "o3de" });
    engineDir("SourceDev", { engine_name: "o3de_sourcedev" });
    writeManifest([path.join(root, "SourceDev"), editor], {}); // legacy map has no "o3de"

    const engine = resolveProjectEngine(project("o3de"));
    assert.strictEqual(engine?.path, editor);
  });

  test("the workspace's engine folder outranks a manifest engine of the same name", () => {
    const registered = engineDir("Registered", { engine_name: "o3de" });
    const inWorkspace = engineDir("Workspace", { engine_name: "o3de" });
    writeManifest([registered], {});
    setWorkspaceEngineRoots(() => [inWorkspace]);

    assert.strictEqual(resolveProjectEngine(project("o3de"))?.path, inWorkspace);
  });

  test("falls back to the legacy engines_path map when nothing else answers", () => {
    const legacy = engineDir("Legacy", { engine_name: "GS_Play_Engine" });
    writeManifest([], { GS_Play_Engine: legacy }); // in the legacy map, absent from `engines`

    assert.strictEqual(resolveProjectEngine(project("GS_Play_Engine"))?.path, legacy);
  });

  test("a stale engines_path entry never outranks the workspace's engine", () => {
    // The map still points "o3de" at a directory that has since been renamed.
    const stale = engineDir("Stale", { engine_name: "o3de-renamed-since" });
    const inWorkspace = engineDir("Workspace", { engine_name: "o3de" });
    writeManifest([], { o3de: stale });
    setWorkspaceEngineRoots(() => [inWorkspace]);

    assert.strictEqual(resolveProjectEngine(project("o3de"))?.path, inWorkspace);
  });

  test("a name that matches nothing still resolves the workspace's lone source engine", () => {
    const inWorkspace = engineDir("Workspace", { engine_name: "o3de" });
    writeManifest([], {});
    setWorkspaceEngineRoots(() => [inWorkspace]);

    assert.strictEqual(resolveProjectEngine(project("some-stale-name"))?.path, inWorkspace);
    assert.strictEqual(resolveProjectEngine(project(undefined))?.path, inWorkspace);
  });

  test("a prebuilt SDK engine is not used as the nameless fallback", () => {
    const sdk = engineDir("Sdk", { engine_name: "o3de-sdk", sdk_engine: true });
    writeManifest([], {});
    setWorkspaceEngineRoots(() => [sdk]);

    assert.strictEqual(resolveProjectEngine(project("some-stale-name")), undefined);
  });

  test("two same-named workspace engines are ambiguous — no guess", () => {
    const a = engineDir("A", { engine_name: "o3de" });
    const b = engineDir("B", { engine_name: "o3de" });
    writeManifest([], {});
    setWorkspaceEngineRoots(() => [a, b]);

    assert.strictEqual(resolveProjectEngine(project("stale")), undefined);
  });

  // ---- Path-dominant: <project>/user/project.json engine_path ----------------
  test("engine_path wins over a same-named engine — the real EngineSource2 record", () => {
    // Two registered engines are both named "o3de"; name matching picked the first. The project was built
    // against the second, and its user/project.json says so directly.
    const stabilization = engineDir("O3DE-stabilization", { engine_name: "o3de", version: "2.7.0" });
    const editor = engineDir("O3DEEditor", { engine_name: "o3de", version: "2.7.0" });
    writeManifest([stabilization, editor], {});

    assert.strictEqual(resolveProjectEngine(project("o3de"))?.path, stabilization, "legacy name-only record: first match");
    assert.strictEqual(resolveProjectEngine(project("o3de", editor))?.path, editor, "direct path record wins");
  });

  test("engine_path wins even over a workspace engine and a name that points elsewhere", () => {
    const named = engineDir("GS_Play_Engine", { engine_name: "GS_Play_Engine", sdk_engine: true });
    const direct = engineDir("OtherEngine", { engine_name: "OtherEngine" });
    writeManifest([named], {});
    setWorkspaceEngineRoots(() => [named]);

    assert.strictEqual(resolveProjectEngine(project("GS_Play_Engine", direct))?.engineName, "OtherEngine");
  });

  test("a stale engine_path (engine moved or deleted) falls back to the legacy name chain", () => {
    const named = engineDir("GS_Play_Engine", { engine_name: "GS_Play_Engine" });
    writeManifest([named], {});

    const resolved = resolveProjectEngine(project("GS_Play_Engine", path.join(root, "gone")));
    assert.strictEqual(resolved?.path, named);
  });
});

suite("readProject: user/project.json merged over project.json", () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-userproj-"));
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ project_name: "EngineSource2", engine: "o3de" }));
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writeUser = (json: Record<string, unknown>) => {
    fs.mkdirSync(path.join(dir, "user"), { recursive: true });
    fs.writeFileSync(path.join(dir, "user", "project.json"), JSON.stringify(json));
  };

  test("reads engine_path — the direct record O3DE writes", () => {
    writeUser({ engine_path: "D:/OffLocalDev/O3DEEditor" });
    const p = readProject(dir)!;
    assert.strictEqual(p.enginePath, "D:/OffLocalDev/O3DEEditor");
    assert.strictEqual(p.engine, "o3de", "the name is still there for legacy fallback");
  });

  test("an `engine` in user/project.json overrides the name, as O3DE's merge does", () => {
    writeUser({ engine: "o3de-sdk" });
    assert.strictEqual(readProject(dir)!.engine, "o3de-sdk");
  });

  test("no user/project.json → a legacy name-only record, unchanged", () => {
    const p = readProject(dir)!;
    assert.strictEqual(p.enginePath, undefined);
    assert.strictEqual(p.engine, "o3de");
  });

  test("a relative engine_path is taken relative to the project folder", () => {
    writeUser({ engine_path: "../Engines/O3DE" });
    assert.strictEqual(readProject(dir)!.enginePath, path.join(dir, "../Engines/O3DE"));
  });

  test("an empty engine_path is no record at all", () => {
    writeUser({ engine_path: "  " });
    assert.strictEqual(readProject(dir)!.enginePath, undefined);
  });

  test("the user/ folder itself is never mistaken for a project", () => {
    writeUser({ engine_path: "D:/OffLocalDev/O3DEEditor" });
    assert.strictEqual(readProject(path.join(dir, "user")), undefined);
  });
});
