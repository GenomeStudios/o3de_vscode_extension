// ============================================================================
//  clangd server resolution — does the clangd LANGUAGE SERVER exist, found the
//  way the clangd extension itself finds it?
//
//  clangd is two pieces: the VS Code extension, and the clangd executable it runs.
//  The extension reads `clangd.path` (default "clangd"), substitutes variables, and:
//    • a value containing a slash is a file path — relative ones sit under the
//      workspace root;
//    • a bare name is looked up on PATH.
//  When the extension downloads the server itself it writes the absolute path of
//  that binary back to `clangd.path` (user settings), so both cases are covered.
//
//  Pure: environment, platform, home, workspace root and `exists` are injected.
// ============================================================================

import * as path from "path";

// ---- Model -----------------------------------------------------------------
export interface ClangdResolveContext {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  workspaceRoot?: string;
  exists: (file: string) => boolean;
}

// ---- Variables -------------------------------------------------------------
/**
 * The substitutions the clangd extension applies to its settings. `${config:…}` and
 * `${command:…}` are left in place: resolving them needs vscode, and running an arbitrary
 * command just to probe for a file is not acceptable — such a path reads as unresolved.
 */
export function substituteClangdVariables(value: string, context: ClangdResolveContext): string {
  return value.replace(/\$\{(.*?)\}/g, (placeholder, name: string) => {
    if (name === "userHome") {
      return context.home;
    }
    if (name === "workspaceRoot" || name === "workspaceFolder" || name === "cwd") {
      return context.workspaceRoot ?? placeholder;
    }
    if (name === "workspaceFolderBasename") {
      return context.workspaceRoot ? path.basename(context.workspaceRoot) : placeholder;
    }
    if (name.startsWith("env:")) {
      return context.env[name.slice(4)] ?? placeholder;
    }
    return placeholder;
  });
}

// ---- Resolution ------------------------------------------------------------
/** The clangd executable `clangd.path` resolves to, or undefined when it doesn't exist. */
export function resolveClangdExecutable(configured: string, context: ClangdResolveContext): string | undefined {
  const value = substituteClangdVariables(configured.trim() || "clangd", context);
  if (value.includes("${")) {
    return undefined; // an unresolvable variable can't name a real file
  }
  const p = context.platform === "win32" ? path.win32 : path.posix;
  // On Windows an extensionless name is tried with each PATHEXT suffix FIRST, so a directory that
  // happens to be called "clangd" can never win over clangd.exe.
  const windowsExtensions = (name: string): string[] =>
    context.platform === "win32" && !p.extname(name)
      ? [...(context.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean), ""]
      : [""];

  // A value with a slash is a file path.
  if (/[\\/]/.test(value)) {
    const file = p.isAbsolute(value) ? value : p.join(context.workspaceRoot ?? "", value);
    return windowsExtensions(file).map((ext) => file + ext).find(context.exists);
  }

  // A bare name is looked up on PATH.
  const searchPath = context.env.PATH ?? context.env.Path ?? "";
  for (const dir of searchPath.split(p.delimiter).filter(Boolean)) {
    const hit = windowsExtensions(value).map((ext) => p.join(dir, value + ext)).find(context.exists);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}
