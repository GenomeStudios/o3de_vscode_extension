// ============================================================================
//  O3DE manifest — ~/.o3de/o3de_manifest.json (override via O3DE_HOME).
//
//  The registry of engines / projects / gems. Pre-fills the setup wizard so the
//  user never has to browse blindly. Field names verified against the real file.
// ============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface O3deManifest {
  engines: string[]; // engine root DIRECTORIES — the forward form; resolve from these
  enginesByName: Record<string, string>; // LEGACY `engines_path` name → path; fallback only
  projects: string[]; // project root paths
  gems: string[]; // external_subdirectories (registered gem paths)
  defaultProjectsFolder?: string;
  defaultThirdPartyFolder?: string; // LY_3RDPARTY_PATH source
}

/** Location of the manifest: $O3DE_HOME/.. or ~/.o3de/o3de_manifest.json. */
export function manifestPath(): string {
  const home = process.env["O3DE_HOME"] ?? path.join(os.homedir(), ".o3de");
  return path.join(home, "o3de_manifest.json");
}

/** Pure: manifest JSON → typed record. */
export function parseManifest(json: Record<string, unknown>): O3deManifest {
  const enginesByName =
    json.engines_path && typeof json.engines_path === "object"
      ? (json.engines_path as Record<string, string>)
      : {};
  return {
    engines: Array.isArray(json.engines) ? (json.engines as string[]) : [],
    enginesByName,
    projects: Array.isArray(json.projects) ? (json.projects as string[]) : [],
    gems: Array.isArray(json.external_subdirectories)
      ? (json.external_subdirectories as string[])
      : [],
    defaultProjectsFolder:
      typeof json.default_projects_folder === "string" ? json.default_projects_folder : undefined,
    defaultThirdPartyFolder:
      typeof json.default_third_party_folder === "string"
        ? json.default_third_party_folder
        : undefined,
  };
}

/** Read + parse the manifest, or undefined if missing/unreadable. */
export function readManifest(): O3deManifest | undefined {
  try {
    return parseManifest(JSON.parse(fs.readFileSync(manifestPath(), "utf8")));
  } catch {
    return undefined;
  }
}
