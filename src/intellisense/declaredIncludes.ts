// ============================================================================
//  Declared include dirs — the include directories a gem's own CMake files declare.
//
//  A gem names the folders its sources #include from in its own CMakeLists.txt, and not always
//  the conventional ones (ImageProcessingAtom lists `../External/CubeMapGen`, a folder beside its
//  Code folder). Guessing Include / Source / Platform/<host> misses them, so a gem's database
//  entries also take the directories its CMake declares. Nothing here names a gem or a path: the
//  answer comes from the user's own CMake text.
//
//  READS     the paths after PUBLIC / PRIVATE / INTERFACE in an ly_add_target `INCLUDE_DIRECTORIES`
//            block or a plain `target_include_directories(<target> ...)` call (the block runs to the
//            next ly_add_target keyword or the closing parenthesis; moduleDefines.ts's block scanner
//            does that, as it does for COMPILE_DEFINITIONS). Relative paths resolve against the
//            CMakeLists.txt folder.
//
//  VARIABLES  only the ones that can be known without running CMake:
//              CMAKE_CURRENT_LIST_DIR / CMAKE_CURRENT_SOURCE_DIR   the CMakeLists.txt folder
//              PAL_PLATFORM_NAME / PAL_HOST_PLATFORM_NAME (+ _LOWERCASE)   the host's PAL name
//              <var>  set by `set(<var> <path>)`, `o3de_pal_dir(<var> <path> ...)` or
//                     `ly_get_list_relative_pal_filename(<var> <path> ...)` in the SAME file
//              plus whatever the caller knows (gem_name and gem_path, from the gem's gem.json). The
//              file's own set() overrides those, unless it is a default under `if(NOT <var>)`, as in
//              the gem template's preamble: the caller's value stands there.
//             O3DE gems have no global PAL variable (verified in cmake/PAL.cmake, cmake/Gems.cmake):
//             `${pal_source_dir}` is each gem's own `o3de_pal_dir(pal_source_dir
//             ${CMAKE_CURRENT_LIST_DIR}/Source/Platform/${PAL_PLATFORM_NAME} ...)`, a folder inside
//             the gem that exists for this host. Anything else (`${pal_tools_include_dirs}`, built
//             in a loop; `${CMAKE_CURRENT_BINARY_DIR}`; a generator expression) is skipped quietly.
//
//  The result is every candidate directory, absolute, forward slashes. Whether a folder exists on
//  disk is the caller's business (databasePlan.ts keeps the ones that do).
//
//  Pure; vscode-free.
// ============================================================================

import * as path from "path";
import { blocksOf, withoutComments } from "./moduleDefines";
import { normalizePath, uniqueStable } from "./paths";

// ---- Platform --------------------------------------------------------------
/** The PAL name of each host platform (`PAL_PLATFORM_NAME`, and the folder name under `Platform/`). */
const PAL_PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: "Windows", linux: "Linux", darwin: "Mac" };

/** The PAL folder name of the host platform, or undefined for a platform O3DE has no PAL folder for here. */
export function palFolderName(platform: NodeJS.Platform): string | undefined {
  return PAL_PLATFORM_NAMES[platform];
}

// ---- Variables -------------------------------------------------------------
/** A command that gives a variable a path: `set(<var> <value>)` (a lone value), or a PAL command (value first). */
const PATH_VARIABLE = /\b(set|o3de_pal_dir|ly_get_list_relative_pal_filename)\s*\(\s*([A-Za-z_]\w*)\s+("[^"]*"|[^\s)"]+)([^)]*)\)/gi;

/** `if(NOT <var>)`: a `set(<var> ...)` it wraps is only a default (the template's `if(NOT gem_name) set(gem_name ...)`). */
const DEFAULT_GUARD = /\bif\s*\(\s*NOT\s+([A-Za-z_]\w*)\s*\)/gi;

const unquoted = (token: string): string => token.replace(/^"(.*)"$/, "$1");

/** `token` with every known `${variable}` replaced; unknown ones stay as written. */
function substitute(token: string, variables: Map<string, string>): string {
  return token.replace(/\$\{([^}]*)\}/g, (reference, name: string) => variables.get(name) ?? reference);
}

/** The variables the file's own text lets us know, on top of the built-in ones and the caller's. */
function knownVariables(text: string, cmakeDir: string, platform: NodeJS.Platform, extra: Record<string, string>): Map<string, string> {
  const pal = palFolderName(platform);
  const variables = new Map<string, string>([["CMAKE_CURRENT_LIST_DIR", cmakeDir], ["CMAKE_CURRENT_SOURCE_DIR", cmakeDir]]);
  if (pal) {
    for (const prefix of ["PAL_PLATFORM_NAME", "PAL_HOST_PLATFORM_NAME"]) {
      variables.set(prefix, pal);
      variables.set(`${prefix}_LOWERCASE`, pal.toLowerCase());
    }
  }
  Object.entries(extra).forEach(([name, value]) => variables.set(name, value));
  const callerHas = (name: string): boolean => Object.hasOwn(extra, name);
  const defaulted = new Set([...text.matchAll(DEFAULT_GUARD)].map(([, name]) => name));

  for (const [, command, name, value, rest] of text.matchAll(PATH_VARIABLE)) {
    if (command.toLowerCase() === "set" && rest.trim() !== "") {
      continue; // a list, or set(<var> <value> PARENT_SCOPE / CACHE ...): not a plain path
    }
    if (callerHas(name) && defaulted.has(name)) {
      continue; // a default under if(NOT <var>): the caller's value is the one CMake would have
    }
    const resolved = substitute(unquoted(value), variables);
    if (resolved && !resolved.includes("$")) {
      variables.set(name, resolved);
    }
  }
  return variables;
}

// ---- Parsing ---------------------------------------------------------------
/** An ly_add_target `INCLUDE_DIRECTORIES` block, or a plain call (whose first argument, the target, is not a path). */
const INCLUDE_BLOCK = /(?:\bINCLUDE_DIRECTORIES\b|\btarget_include_directories\s*\(\s*[^\s)]+)([^)]*)/g;

/** A block's words: a quoted string or a run of non-blank characters. */
const WORD = /"[^"]*"|[^\s"]+/g;

/** The words of an include block that are no path. */
const NOT_A_PATH = new Set(["PUBLIC", "PRIVATE", "INTERFACE", "SYSTEM", "BEFORE", "AFTER"]);

/** One block word as an absolute path, or undefined for a keyword, a generator expression or an unknown variable. */
function resolveWord(word: string, variables: Map<string, string>, cmakeDir: string): string | undefined {
  if (NOT_A_PATH.has(word)) {
    return undefined;
  }
  const value = substitute(unquoted(word), variables);
  if (!value || value.includes("$")) {
    return undefined;
  }
  const isAbsolute = path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value);
  return normalizePath(isAbsolute ? value : `${cmakeDir}/${value}`).replace(/\/+$/, "");
}

/**
 * The include directories a CMakeLists.txt declares, as absolute forward-slash paths, first-seen order, no repeats.
 * `cmakeDir` is the folder holding the file; `variables` are the values the caller knows (see the header).
 */
export function declaredIncludeDirsIn(cmake: string, cmakeDir: string, platform: NodeJS.Platform, variables: Record<string, string> = {}): string[] {
  const text = withoutComments(cmake);
  const dir = normalizePath(cmakeDir).replace(/\/+$/, "");
  const known = knownVariables(text, dir, platform, variables);
  const dirs = blocksOf(text, INCLUDE_BLOCK).flatMap((block) => (block.match(WORD) ?? []).map((word) => resolveWord(word, known, dir)));
  return uniqueStable(dirs.filter((found): found is string => found !== undefined));
}
