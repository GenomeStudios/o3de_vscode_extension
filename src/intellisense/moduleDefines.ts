// ============================================================================
//  Engine module export defines — the `*_EXPORTS` a source engine file compiles with.
//
//  An O3DE engine module (AzCore, AzFramework, a gem...) builds its own sources with an
//  export define (AZCORE_EXPORTS, AZF_EXPORTS...) that turns its API macros into
//  dllexport. The compile database gives every engine source ONE shared command, built
//  for a CONSUMER of the engine, where those macros mean dllimport. Without the owning
//  module's define, clangd reports -Winconsistent-dllimport on nearly every engine file,
//  and a file defining a static member of an exported class fails outright.
//
//  The defines come from the user's own source engine, never a built-in list:
//
//    owning module   the nearest directory at or above the file, below the engine root,
//                    whose CMakeLists.txt declares a target (a Code/Framework module, a
//                    gem's Code folder)
//    its defines     identifiers ending _EXPORTS / _EXPORT_SYMBOLS inside that file's
//                    COMPILE_DEFINITIONS blocks (comments and ${variables} ignored)
//    fallback        only when parsing finds nothing: a small table of the Framework
//                    modules whose defines are known (AzCore, AzFramework,
//                    AzToolsFramework, AzQtComponents)
//
//  Pure except the disk reader at the bottom; vscode-free.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { isUnderRoot, normalizePath, uniqueStable } from "./paths";

// ---- Model -----------------------------------------------------------------
/** The export defines (`NAME`, no `-D`) of the module that owns an engine source; empty when none are known. */
export type ModuleDefineLookup = (file: string) => string[];

/** The text of the CMakeLists.txt in a directory, or undefined when there is none. */
export type CMakeReader = (dir: string) => string | undefined;

// ---- Parsing a CMakeLists.txt ----------------------------------------------
const EXPORT_DEFINE = /\b[A-Z][A-Z0-9_]*(?:_EXPORTS|_EXPORT_SYMBOLS)\b/g;

/** A block starts at ly_add_target's `COMPILE_DEFINITIONS` keyword or at a plain `target_compile_definitions(` call... */
const DEFINITIONS_BLOCK = /(?:\bCOMPILE_DEFINITIONS\b|\btarget_compile_definitions\s*\()([^)]*)/g;

/**
 * ...and runs to the next ly_add_target keyword (a whole word: the arguments of cmake/LYWrappers.cmake's
 * ly_add_target, minus INTERFACE, which also names a visibility) or the closing parenthesis, whichever comes first.
 */
const NEXT_KEYWORD =
  /(?<!\S)(?:NAME|NAMESPACE|OUTPUT_SUBDIRECTORY|OUTPUT_NAME|FILES_CMAKE|GENERATED_FILES|INCLUDE_DIRECTORIES|COMPILE_DEFINITIONS|BUILD_DEPENDENCIES|RUNTIME_DEPENDENCIES|PLATFORM_INCLUDE_FILES|TARGET_PROPERTIES|AUTOGEN_RULES|STATIC|SHARED|MODULE|GEM_STATIC|GEM_SHARED|GEM_MODULE|OBJECT|HEADERONLY|EXECUTABLE|APPLICATION|IMPORTED|AUTOMOC|AUTOUIC|AUTORCC|NO_UNITY|EXPORT_ALL_SYMBOLS)(?!\S)/;

/** The commands that declare a target. */
const TARGET_DECLARATION = /\b(?:ly_add_target|add_library|add_executable)\s*\(/i;

/** CMake text without bracket comments and line comments. */
export function withoutComments(cmake: string): string {
  return cmake.replace(/#\[(=*)\[[\s\S]*?\]\1\]/g, " ").replace(/#.*$/gm, " ");
}

/** CMake text without comments and `${variable}` references. */
function stripped(cmake: string): string {
  return withoutComments(cmake).replace(/\$\{[^}]*\}/g, " ");
}

/** The text after each `start` match (its capture group 1), cut at the next ly_add_target keyword. `start` must be global. */
export function blocksOf(text: string, start: RegExp): string[] {
  return [...text.matchAll(start)].map(([, block]) => {
    const end = block.search(NEXT_KEYWORD);
    return end < 0 ? block : block.slice(0, end);
  });
}

/** True when the file declares a target (ly_add_target, add_library, add_executable). */
export function declaresTarget(cmake: string): boolean {
  return TARGET_DECLARATION.test(stripped(cmake));
}

/** Every export define named inside the file's COMPILE_DEFINITIONS blocks, first-seen order, no repeats. */
export function exportDefinesIn(cmake: string): string[] {
  return uniqueStable(blocksOf(stripped(cmake), DEFINITIONS_BLOCK).flatMap((block) => block.match(EXPORT_DEFINE) ?? []));
}

// ---- Fallback table --------------------------------------------------------
/** Code/Framework modules whose export defines are known — used only when their CMakeLists.txt can't be parsed. */
const FALLBACK_DEFINES: Record<string, string[]> = {
  azcore: ["AZCORE_EXPORTS"],
  azframework: ["AZF_EXPORTS"],
  aztoolsframework: ["AZTF_EXPORTS"],
  azqtcomponents: ["AZ_QT_COMPONENTS_EXPORT_SYMBOLS"],
};

/** The fallback defines for a file under `<engineRoot>/Code/Framework/<Module>/`, or none. */
export function fallbackExportDefines(file: string, engineRoot: string): string[] {
  if (!isUnderRoot(file, engineRoot)) {
    return [];
  }
  const relative = normalizePath(file).slice(normalizePath(engineRoot).replace(/\/+$/, "").length + 1);
  const moduleName = relative.match(/^Code\/Framework\/([^/]+)\//i)?.[1];
  return moduleName ? (FALLBACK_DEFINES[moduleName.toLowerCase()] ?? []) : [];
}

// ---- Lookup ----------------------------------------------------------------
/**
 * A lookup answering "which export defines does this engine source compile with", for the source engine at
 * `engineRoot`. Each module's CMakeLists.txt is read once: the answer is cached for every directory walked.
 */
export function createModuleDefineLookup(engineRoot: string, readCMake: CMakeReader = readCMakeFromDisk): ModuleDefineLookup {
  const root = normalizePath(engineRoot).replace(/\/+$/, "");
  const belowRoot = (dir: string): boolean => isUnderRoot(dir, root) && normalizePath(dir).toLowerCase() !== root.toLowerCase();
  const byDirectory = new Map<string, string[]>(); // directory (lower-case) → defines of the module owning it

  const definesOwning = (dir: string): string[] => {
    const key = normalizePath(dir).toLowerCase();
    const known = byDirectory.get(key);
    if (known) {
      return known;
    }
    let defines: string[] = [];
    if (belowRoot(dir)) {
      const cmake = readCMake(dir);
      defines = cmake !== undefined && declaresTarget(cmake) ? exportDefinesIn(cmake) : definesOwning(path.posix.dirname(normalizePath(dir)));
    }
    byDirectory.set(key, defines);
    return defines;
  };

  return (file) => {
    const defines = definesOwning(path.posix.dirname(normalizePath(file)));
    return defines.length ? defines : fallbackExportDefines(file, root);
  };
}

// ---- Disk ------------------------------------------------------------------
/** The text of `<dir>/CMakeLists.txt`, or undefined when it can't be read. */
export function readCMakeFromDisk(dir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, "CMakeLists.txt"), "utf8");
  } catch {
    return undefined;
  }
}
