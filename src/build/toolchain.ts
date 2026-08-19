// ============================================================================
//  Toolchain environment — the one seam that used to be "Windows only".
//
//  A cmake configure/build must run in the right compiler environment. On Windows
//  that means sourcing the MSVC env (vcvars64) — the thing CMake Tools can't do
//  for an O3DE project, and the reason the extension runs cmake itself. On Linux
//  the compiler comes from the login shell, so there is NO env to establish: the
//  managed command inherits gcc/clang from PATH and the delta is empty. Both
//  callers (interactive Build/Configure and the MCP headless build) resolve their
//  environment here, so the platform branch lives in exactly one place.
// ============================================================================

import { Compiler } from "./buildOptions";
import { ensureVisualStudio } from "../env/visualStudioGuard";
import { captureMsvcEnvironmentDelta } from "../env/msvcEnvironment";
import { detectGcc, detectClang } from "../deps/detectors";

export interface ToolchainEnv {
  ok: boolean;
  /** Environment delta to merge OVER process.env for the managed command. */
  env: Record<string, string>;
  /** Human-readable toolchain description (for the log). */
  label: string;
  /** Why resolution failed (populated only when ok is false). */
  reason?: string;
}

/**
 * Resolve the environment a configure/build must run in for the current platform
 * and the selected compiler. Windows captures the MSVC delta; Linux verifies the
 * compiler is installed and returns an empty delta (inherit the shell).
 */
export async function resolveBuildEnvironment(compiler: Compiler): Promise<ToolchainEnv> {
  // ---- Windows: source the MSVC environment (vcvars64) --------------------
  if (process.platform === "win32") {
    const vs = await ensureVisualStudio({ interactive: false });
    if (!vs?.vcvars64Path) {
      return { ok: false, env: {}, label: "MSVC", reason: "No usable Visual Studio (MSVC) — vcvars64.bat not found." };
    }
    try {
      const env = await captureMsvcEnvironmentDelta(vs.vcvars64Path);
      return { ok: true, env, label: `MSVC (${vs.displayName ?? "Visual Studio"})` };
    } catch (err) {
      const message = (err as { message?: string }).message ?? String(err);
      return { ok: false, env: {}, label: "MSVC", reason: `Failed to establish the MSVC environment: ${message}` };
    }
  }

  // ---- Linux (and future POSIX): inherit the shell; just verify a compiler --
  // Clang is O3DE's validated Linux default; GCC is used only when explicitly
  // selected. MSVC has no meaning here, so it falls through to the Clang check.
  const useClang = compiler !== "GCC";
  const probe = useClang ? await detectClang() : await detectGcc();
  if (probe.state !== "ok") {
    const name = useClang ? "clang/clang++" : "gcc/g++";
    return {
      ok: false,
      env: {},
      label: name,
      reason: `${name} not found on PATH — install a C++ toolchain (e.g. build-essential or clang), then retry.`,
    };
  }
  return { ok: true, env: {}, label: `${useClang ? "Clang" : "GCC"}${probe.detail ? ` ${probe.detail}` : ""}` };
}
