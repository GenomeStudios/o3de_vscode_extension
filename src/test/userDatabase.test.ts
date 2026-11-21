// ============================================================================
//  Bring your own compile database - o3de.intellisense.compileDatabase.
//
//  Which database clangd reads: generated (the setting is empty), the user's own
//  (a file, or a folder holding one; absolute, or relative to the project), or a
//  fall back to generated when the setting names nothing usable. And the rule that
//  matters most: O3DE never writes a user's database.
//
//  Fixtures are real files in a temp dir, so the checks run against the file system
//  the way the extension does. Nothing depends on this machine's paths.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileDatabaseDir, writeCompileDatabase } from "../intellisense/compileDb";
import { COMPILE_DATABASE_FILE, DatabaseSelection, mayGenerate, noteStillSet, selectDatabase } from "../intellisense/userDatabase";

// ---- Fixture ---------------------------------------------------------------
let root: string;
let project: string;
let buildDir: string;

/** Write `rel` (under the temp root) as a file and return its absolute path. */
function write(rel: string, text = "[]\n"): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function select(setting: string | undefined, platform: NodeJS.Platform = process.platform): DatabaseSelection {
  return selectDatabase({ setting, projectPath: project, buildDir }, platform);
}

setup(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-userdb-"));
  project = path.join(root, "project");
  buildDir = path.join(project, "build", "windows");
  fs.mkdirSync(buildDir, { recursive: true });
});

teardown(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- Empty setting: generated ----------------------------------------------
suite("userDatabase.selectDatabase: setting empty", () => {
  test("empty, whitespace or unset: O3DE generates, and says which setting would change that", () => {
    for (const setting of ["", "   ", undefined]) {
      const selection = select(setting);
      assert.strictEqual(selection.source, "generated", String(setting));
      assert.strictEqual(selection.dir, undefined);
      assert.strictEqual(selection.file, undefined);
      assert.strictEqual(selection.missing, undefined);
      assert.strictEqual(selection.hint, undefined);
      assert.match(selection.reason, /o3de\.intellisense\.compileDatabase is empty/);
    }
  });

  test("a compile_commands.json in the project is only a hint: the selection stays generated", () => {
    const file = write("project/compile_commands.json");
    const selection = select("");
    assert.strictEqual(selection.source, "generated");
    assert.strictEqual(selection.hint, file);
    assert.match(selection.reason, new RegExp(`exists at .*compile_commands\\.json: set o3de\\.intellisense\\.compileDatabase to use it`));
    assert.match(selection.reason, /doesn't switch to it by itself/);
  });

  test("a CMake export in the build folder is a hint too; the project's own file wins when both exist", () => {
    const cmake = write("project/build/windows/compile_commands.json");
    assert.strictEqual(select("").hint, cmake);
    const inProject = write("project/compile_commands.json");
    assert.strictEqual(select("").hint, inProject);
  });

  test("no hint when clangd already reads that folder through the user's own clangd.arguments", () => {
    const file = write("project/compile_commands.json");
    const reads = (clangdDir: string | undefined): DatabaseSelection => selectDatabase({ setting: "", projectPath: project, buildDir, clangdDir }, process.platform);
    const plain = reads(undefined);
    const alreadyRead = reads(project);
    assert.strictEqual(alreadyRead.hint, undefined);
    assert.strictEqual(alreadyRead.source, "generated", "still O3DE's database as far as O3DE is concerned");
    assert.strictEqual(alreadyRead.reason, "O3DE generates clangd's compile database (o3de.intellisense.compileDatabase is empty).", "the plain sentence, no 'set the setting' advice");
    assert.strictEqual(reads(`${project}${path.sep}`).hint, undefined, "a trailing slash is the same folder");
    assert.strictEqual(plain.hint, file, "with no clangd folder known, the hint stays");
    assert.strictEqual(reads(path.join(root, "elsewhere")).hint, file, "clangd reads another folder: the hint stays");
  });

  test("the hint compares the folder clangd reads with the folder of the database that was found, in the build folder too", () => {
    const cmake = write("project/build/windows/compile_commands.json");
    assert.strictEqual(selectDatabase({ setting: "", projectPath: project, buildDir, clangdDir: buildDir }, process.platform).hint, undefined);
    assert.strictEqual(selectDatabase({ setting: "", projectPath: project, buildDir, clangdDir: project }, process.platform).hint, cmake, "clangd reads the project folder, which holds none");
  });

  test("O3DE's own generated database is never offered as a hint", () => {
    write("project/build/windows/clangd/compile_commands.json");
    assert.strictEqual(select("").hint, undefined);
  });
});

// ---- Setting names a database: user's own -----------------------------------
suite("userDatabase.selectDatabase: the user's own database", () => {
  test("an absolute path to the file", () => {
    const file = write("shared/compile_commands.json");
    const selection = select(file);
    assert.strictEqual(selection.source, "user");
    assert.strictEqual(selection.file, file);
    assert.strictEqual(selection.dir, path.dirname(file));
    assert.strictEqual(selection.missing, undefined);
    assert.match(selection.reason, /Your own compile database/);
  });

  test("an absolute path to the folder holding it", () => {
    const file = write("shared/compile_commands.json");
    const selection = select(path.dirname(file));
    assert.strictEqual(selection.source, "user");
    assert.strictEqual(selection.file, file);
    assert.strictEqual(selection.dir, path.dirname(file));
  });

  test("a relative file name resolves against the project folder", () => {
    const file = write("project/compile_commands.json");
    const selection = select("compile_commands.json");
    assert.strictEqual(selection.source, "user");
    assert.strictEqual(selection.file, file);
    assert.strictEqual(selection.dir, project);
  });

  test("a relative folder resolves against the project folder", () => {
    const file = write("project/build/windows/compile_commands.json");
    const selection = select(path.join("build", "windows"));
    assert.strictEqual(selection.source, "user");
    assert.strictEqual(selection.file, file);
  });

  test("a relative path may climb out of the project", () => {
    const file = write("shared/db/compile_commands.json");
    const selection = select(path.join("..", "shared", "db"));
    assert.strictEqual(selection.source, "user");
    assert.strictEqual(selection.file, file);
  });

  test("surrounding whitespace in the setting is ignored", () => {
    const file = write("shared/compile_commands.json");
    assert.strictEqual(select(`  ${file}  `).file, file);
  });

  test("the setting wins over a database that merely exists in the project", () => {
    write("project/compile_commands.json");
    const chosen = write("shared/compile_commands.json");
    const selection = select(chosen);
    assert.strictEqual(selection.file, chosen);
    assert.strictEqual(selection.hint, undefined, "no hint once the user has chosen");
  });

  test("the file name must be compile_commands.json: letter case only counts off Windows", () => {
    const odd = write("shared/Compile_Commands.json");
    assert.strictEqual(select(odd, "win32").source, "user");
    const linux = select(odd, "linux");
    assert.strictEqual(linux.source, "generated");
    assert.strictEqual(linux.missing?.reason, "wrongName");
  });
});

// ---- Setting names nothing usable: fall back --------------------------------
suite("userDatabase.selectDatabase: a setting that names nothing usable", () => {
  test("a path that doesn't exist falls back to generated and says so", () => {
    const wanted = path.join(root, "nowhere", "compile_commands.json");
    const selection = select(wanted);
    assert.strictEqual(selection.source, "generated");
    assert.strictEqual(selection.dir, undefined);
    assert.strictEqual(selection.missing?.reason, "notFound");
    assert.strictEqual(selection.missing?.resolved, wanted);
    assert.match(selection.reason, /o3de\.intellisense\.compileDatabase is ".*nowhere.*", but no compile_commands\.json exists at/);
    assert.match(selection.reason, /generates the database instead/);
  });

  test("a relative path that doesn't exist reports where it looked: against the project", () => {
    const selection = select("db/compile_commands.json");
    assert.strictEqual(selection.missing?.resolved, path.resolve(project, "db", "compile_commands.json"));
  });

  test("a folder with no compile_commands.json in it is missing, not user", () => {
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    const selection = select(path.join(root, "empty"));
    assert.strictEqual(selection.source, "generated");
    assert.strictEqual(selection.missing?.reason, "notFound");
  });

  test("a file clangd would never read (another name) is missing, with a reason that names the file name", () => {
    const file = write("shared/commands.json");
    const selection = select(file);
    assert.strictEqual(selection.source, "generated");
    assert.strictEqual(selection.missing?.reason, "wrongName");
    assert.match(selection.reason, /isn't named compile_commands\.json, the only name clangd reads/);
  });

  test("the hint is for an empty setting only: a missing path doesn't also offer one", () => {
    write("project/compile_commands.json");
    assert.strictEqual(select(path.join(root, "nowhere")).hint, undefined);
  });
});

// ---- O3DE's own folder ------------------------------------------------------
suite("userDatabase.selectDatabase: O3DE's own generated folder", () => {
  test("naming it is not 'your own database': O3DE keeps generating there", () => {
    const generatedDir = compileDatabaseDir(buildDir);
    write("project/build/windows/clangd/compile_commands.json");
    for (const setting of [generatedDir, path.join(generatedDir, COMPILE_DATABASE_FILE), path.join("build", "windows", "clangd")]) {
      const selection = select(setting);
      assert.strictEqual(selection.source, "generated", setting);
      assert.strictEqual(selection.missing, undefined, setting);
      assert.match(selection.reason, /names O3DE's own generated database folder/);
    }
  });
});

// ---- Never overwrite a user's database --------------------------------------
suite("userDatabase: O3DE never writes a user's database", () => {
  test("mayGenerate is false for the user's own database, true for generated and for a missing one", () => {
    const own = write("shared/compile_commands.json");
    assert.strictEqual(mayGenerate(select(own)), false);
    assert.strictEqual(mayGenerate(select("")), true);
    assert.strictEqual(mayGenerate(select(path.join(root, "nowhere"))), true);
    assert.strictEqual(mayGenerate(select(compileDatabaseDir(buildDir))), true);
  });

  test("the generated file's path is never the user's file, wherever the user keeps theirs", () => {
    const generatedFile = path.join(compileDatabaseDir(buildDir), COMPILE_DATABASE_FILE);
    const places = ["project/compile_commands.json", "project/build/windows/compile_commands.json", "shared/compile_commands.json"];
    for (const place of places) {
      const file = write(place);
      const selection = select(file);
      assert.strictEqual(selection.source, "user", place);
      assert.notStrictEqual(path.resolve(selection.file ?? ""), path.resolve(generatedFile), place);
    }
  });

  test("a generation writes only under <build>/clangd: the user's files stay byte for byte", () => {
    const inProject = write("project/compile_commands.json", '[{"file":"mine.cpp"}]\n');
    const cmakeExport = write("project/build/windows/compile_commands.json", '[{"file":"cmake.cpp"}]\n');
    const elsewhere = write("shared/compile_commands.json", '[{"file":"shared.cpp"}]\n');

    const result = writeCompileDatabase(buildDir, [{ directory: buildDir, file: "o3de.cpp", arguments: ["cl", "o3de.cpp"] }]);

    assert.strictEqual(result.file, path.join(compileDatabaseDir(buildDir), COMPILE_DATABASE_FILE));
    assert.strictEqual(fs.readFileSync(inProject, "utf8"), '[{"file":"mine.cpp"}]\n');
    assert.strictEqual(fs.readFileSync(cmakeExport, "utf8"), '[{"file":"cmake.cpp"}]\n');
    assert.strictEqual(fs.readFileSync(elsewhere, "utf8"), '[{"file":"shared.cpp"}]\n');
  });
});

// ---- Clearing the setting while another scope still sets it -----------------
suite("userDatabase.noteStillSet", () => {
  test("a value still in force after the workspace-folder one was removed is said, and the selection is otherwise untouched", () => {
    const own = write("shared/compile_commands.json");
    const effective = select(own); // what is read after "" removed the folder value: a User or Workspace value remains
    const noted = noteStillSet(effective);
    assert.strictEqual(noted?.source, "user", "the user's database is what applies");
    assert.strictEqual(noted?.file, effective.file);
    assert.strictEqual(noted?.setting, effective.setting);
    assert.ok(noted?.reason.startsWith(effective.reason), "the selection's own sentence comes first");
    assert.match(noted?.reason ?? "", /workspace-folder value was removed, but o3de\.intellisense\.compileDatabase is still set in your User or Workspace settings/);
  });

  test("a missing database named by a remaining value is noted too (it still falls back to generated)", () => {
    const noted = noteStillSet(select(path.join(root, "nowhere")));
    assert.strictEqual(noted?.source, "generated");
    assert.ok(noted?.missing);
    assert.match(noted?.reason ?? "", /still set in your User or Workspace settings/);
  });

  test("nothing remains set: the selection comes back as it was, and undefined stays undefined", () => {
    const generated = select("");
    assert.deepStrictEqual(noteStillSet(generated), generated);
    assert.strictEqual(noteStillSet(undefined), undefined);
  });
});
