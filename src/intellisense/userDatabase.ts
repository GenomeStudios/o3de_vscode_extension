// ============================================================================
//  Bring your own compile database - o3de.intellisense.compileDatabase.
//
//  By default O3DE generates clangd's compile database (compileDb.ts) into
//  <build>/clangd/. A user who already has one (a CMake export, a capture, a
//  hand-trimmed copy) names it in the setting:
//
//    ""        generated: the default
//    a file    .../compile_commands.json
//    a folder  the folder holding a compile_commands.json
//
//  Absolute, or relative to the project folder. Three outcomes:
//
//    user       the file exists. clangd's --compile-commands-dir points at its folder
//               and O3DE never writes it: generation and the sync are off.
//    missing    the setting names nothing usable. O3DE says so (selection.missing) and
//               falls back to the generated database.
//    generated  the setting is empty, or names O3DE's own generated folder.
//
//  An empty setting never switches by itself: a compile_commands.json found in the
//  project or its build folder may be stale, so it is only reported (selection.hint) -
//  unless clangd already reads that folder through the user's own clangd.arguments
//  (inputs.clangdDir), where there is nothing to offer.
//
//  vscode-free: the setting's text in, the decision out. Only reads the file system,
//  to see whether the named files exist.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { sameDirectory } from "./clangdDatabase";
import { compileDatabaseDir } from "./compileDb";

// ---- Model -----------------------------------------------------------------
export const COMPILE_DATABASE_SETTING = "o3de.intellisense.compileDatabase";

/** The only file name clangd reads from a --compile-commands-dir. */
export const COMPILE_DATABASE_FILE = "compile_commands.json";

export interface MissingDatabase {
  resolved: string; // what the setting resolved to
  reason: "notFound" | "wrongName"; // nothing there | a file clangd would never read
}

export interface DatabaseSelection {
  source: "generated" | "user"; // which database clangd reads
  setting: string; // the setting as the user wrote it ("" = unset)
  dir?: string; // user: the folder clangd's --compile-commands-dir points at
  file?: string; // user: the compile_commands.json in it
  missing?: MissingDatabase; // the setting named nothing usable; source is "generated" because of it
  hint?: string; // setting empty, and a database already exists here (never used automatically)
  reason: string; // one sentence: which database, and why
}

export interface SelectionInputs {
  setting: string | undefined; // o3de.intellisense.compileDatabase
  projectPath: string; // relative settings resolve against it
  buildDir: string; // the project's build tree: holds the generated database, and a CMake export to hint at
  /** The folder clangd reads right now (its own --compile-commands-dir), while clangd runs: a database there needs no hint. */
  clangdDir?: string;
}

// ---- Rules -----------------------------------------------------------------
/** May O3DE write (generate or overwrite) the database for this selection? Never when it is the user's. */
export function mayGenerate(selection: DatabaseSelection): boolean {
  return selection.source === "generated";
}

/**
 * The selection read right after "" removed the workspace-folder value of the setting. If a value is still in force
 * (set in the User or Workspace settings: selection.setting is not empty), the selection already follows it; this adds
 * the sentence saying why clearing changed less than asked.
 */
export function noteStillSet(selection: DatabaseSelection | undefined): DatabaseSelection | undefined {
  if (!selection || selection.setting === "") {
    return selection;
  }
  const note = `The workspace-folder value was removed, but ${COMPILE_DATABASE_SETTING} is still set in your User or Workspace settings, so that value applies.`;
  return { ...selection, reason: `${selection.reason} ${note}` };
}

// ---- Selection -------------------------------------------------------------
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDatabaseName(file: string, platform: NodeJS.Platform): boolean {
  const name = path.basename(file);
  return platform === "win32" ? name.toLowerCase() === COMPILE_DATABASE_FILE : name === COMPILE_DATABASE_FILE;
}

/** The database a setting value names: a file, or the file inside a folder. */
function locate(resolved: string, platform: NodeJS.Platform): { file: string } | { missing: MissingDatabase } {
  if (isFile(resolved)) {
    return isDatabaseName(resolved, platform) ? { file: resolved } : { missing: { resolved, reason: "wrongName" } };
  }
  const inside = path.join(resolved, COMPILE_DATABASE_FILE);
  return isFile(inside) ? { file: inside } : { missing: { resolved, reason: "notFound" } };
}

/** A compile_commands.json already sitting in the project or its build folder (the project's wins). */
function findExistingDatabase(inputs: SelectionInputs): string | undefined {
  return [path.join(inputs.projectPath, COMPILE_DATABASE_FILE), path.join(inputs.buildDir, COMPILE_DATABASE_FILE)].find(isFile);
}

function generated(setting: string, extras: Pick<DatabaseSelection, "missing" | "hint" | "reason">): DatabaseSelection {
  return { source: "generated", setting, ...extras };
}

/** Which compile database clangd reads for this project, and why. */
export function selectDatabase(inputs: SelectionInputs, platform: NodeJS.Platform = process.platform): DatabaseSelection {
  const setting = (inputs.setting ?? "").trim();

  if (setting === "") {
    const found = findExistingDatabase(inputs);
    const alreadyRead = found !== undefined && inputs.clangdDir !== undefined && sameDirectory(path.dirname(found), inputs.clangdDir, platform);
    const hint = alreadyRead ? undefined : found; // clangd reads that folder through the user's own clangd.arguments: nothing to offer
    const base = `O3DE generates clangd's compile database (${COMPILE_DATABASE_SETTING} is empty).`;
    return generated(setting, {
      hint,
      reason: hint
        ? `${base} A compile database exists at ${hint}: set ${COMPILE_DATABASE_SETTING} to use it. O3DE doesn't switch to it by itself, because it may be out of date.`
        : base,
    });
  }

  const resolved = path.resolve(inputs.projectPath, setting);
  const located = locate(resolved, platform);
  if ("missing" in located) {
    const what =
      located.missing.reason === "wrongName"
        ? `${resolved} isn't named ${COMPILE_DATABASE_FILE}, the only name clangd reads`
        : `no ${COMPILE_DATABASE_FILE} exists at ${resolved}`;
    return generated(setting, { missing: located.missing, reason: `${COMPILE_DATABASE_SETTING} is "${setting}", but ${what}. O3DE generates the database instead.` });
  }

  const dir = path.dirname(located.file);
  if (sameDirectory(dir, compileDatabaseDir(inputs.buildDir), platform)) {
    return generated(setting, { reason: `${COMPILE_DATABASE_SETTING} names O3DE's own generated database folder, so O3DE keeps generating it.` });
  }
  return {
    source: "user",
    setting,
    dir,
    file: located.file,
    reason:
      `Your own compile database, ${located.file}, is selected (${COMPILE_DATABASE_SETTING}). clangd reads it whenever clangd is the ` +
      `IntelliSense engine; O3DE never writes or overwrites it, so generation and the sync are off.`,
  };
}
