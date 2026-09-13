// ============================================================================
//  LLVM toolchain location — where a standalone LLVM/Clang install lives when it
//  is NOT on PATH.
//
//  The Ninja + Clang build passes bare `clang` / `clang++` to CMake, which finds
//  them on PATH — so an LLVM install that isn't on PATH can't be built with, even
//  though it is installed. winget's LLVM package has been reported not to add
//  itself to PATH, so onboarding looks in LLVM's default install folder too, to
//  tell "not installed" apart from "installed, but not on PATH".
//
//  Pure: environment, platform and `exists` are injected.
// ============================================================================

import * as path from "path";

/** LLVM's default `bin` folder when it holds clang, else undefined. Windows only — elsewhere the
 *  package manager puts clang on PATH. */
export function defaultLlvmBinDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): string | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  // ProgramW6432 is the 64-bit Program Files even when read from a 32-bit process.
  const roots = [env.ProgramW6432, env.ProgramFiles].filter((root): root is string => Boolean(root));
  const seen = new Set<string>();
  for (const root of roots) {
    const bin = path.win32.join(root, "LLVM", "bin");
    if (seen.has(bin.toLowerCase())) {
      continue;
    }
    seen.add(bin.toLowerCase());
    if (exists(path.win32.join(bin, "clang.exe"))) {
      return bin;
    }
  }
  return undefined;
}
