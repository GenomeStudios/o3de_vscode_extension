// ============================================================================
//  Job keys — the managed-command registry key for each kind of project job.
//
//  Build refuses to start while a configure runs and configure refuses while a
//  build runs, so each side must know the other's key. Keeping both here (rather
//  than in buildRun.ts / configure.ts, which import each other's guards) avoids
//  an import cycle. One job of each kind per project.
// ============================================================================

/** The registry key for a project's build. */
export function buildJobKey(projectPath: string): string {
  return `build:${projectPath}`;
}

/** The registry key for a project's configure. */
export function configureJobKey(projectPath: string): string {
  return `configure:${projectPath}`;
}
