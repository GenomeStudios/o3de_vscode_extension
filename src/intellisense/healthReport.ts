// ============================================================================
//  IntelliSense health check - what the report says. Pure text; vscode-free.
//
//    findings           plain sentences: what is wrong, and what to do about it
//    summary line       one line (the MCP tool's first content block, the command's message)
//    Markdown document  the report a user can read and paste into an issue
//
//  The structured report (healthModel.ts) is the truth; this module only words it.
// ============================================================================

import type { OriginCounts } from "./databasePlan";
import type { EngineMode } from "./engineMode";
import { FileCheck, HealthReport, Origin, SampleOrigin } from "./healthModel";

// ---- Wording ---------------------------------------------------------------
const count = (value: number): string => value.toLocaleString("en-US");

const plural = (value: number, noun: string): string => `${count(value)} ${value === 1 ? noun : `${noun.replace(/y$/, "ie")}s`}`;

const ORIGIN_LABEL: Record<SampleOrigin, string> = {
  project: "project",
  gem: "gem",
  engineFramework: "engine Framework",
  engineGems: "engine gem",
  fallback: "fallback gem",
  noEntry: "no entry",
};

const ORDER: Origin[] = ["project", "gem", "engineFramework", "engineGems", "fallback"];

/** "394 project, 100 gem, 1,265 engine Framework, 165 engine gem, 12 fallback gem" - the nonzero origins. */
export function originsLine(origins: OriginCounts): string {
  const parts = ORDER.filter((origin) => origins[origin] > 0).map((origin) => `${count(origins[origin])} ${ORIGIN_LABEL[origin]}`);
  return parts.length ? parts.join(", ") : "none";
}

/** The hint for an engine that ships headers only (none for every other mode). */
export function engineHint(mode: EngineMode, remedyAvailable: boolean): string | undefined {
  if (mode !== "headersOnly") {
    return undefined;
  }
  return remedyAvailable
    ? "Attach a source engine for engine navigation: one is registered on this machine, add it to the workspace with O3DE: Set Up Workspace."
    : "Attach a source engine for engine navigation: the SDK engine ships headers only, so clangd cannot reach engine implementation.";
}

function engineText(report: HealthReport): string {
  const { mode, sourceEngine } = report.engine;
  switch (mode) {
    case "native":
      return "native (the project builds against a source engine)";
    case "redirected":
      return `redirected (SDK engine, navigation goes to source engine ${sourceEngine ?? "in the workspace"})`;
    case "headersOnly":
      return "headersOnly (SDK engine, headers only)";
    case "unresolved":
      return "unresolved";
  }
}

const names = (files: FileCheck[]): string =>
  files
    .slice(0, 3)
    .map((file) => file.file.split(/[\\/]/).pop())
    .join(", ") + (files.length > 3 ? ", ..." : "");

// ---- Findings --------------------------------------------------------------
function databaseRemedy(report: HealthReport): string {
  switch (report.database.kind) {
    case "generated":
      return "Configure the project (O3DE: Configure Project): O3DE generates the database from the configure.";
    case "user":
      return "Check the path in o3de.intellisense.compileDatabase.";
    case "clangdArguments":
      return "Check the --compile-commands-dir in clangd.arguments.";
  }
}

/** Include directories the database names that aren't on disk: built ones (a build creates them) apart from the rest. */
function includeDirFindings(report: HealthReport): string[] {
  const { missing, inBuildFolder, examples } = report.database.includeDirs;
  const elsewhere = missing - inBuildFolder;
  const findings: string[] = [];
  const list = (dirs: string[], total: number): string => `(${dirs.join(", ")}${total > dirs.length ? ", ..." : ""})`;
  if (elsewhere > 0) {
    const shown = examples.slice(0, Math.min(examples.length, elsewhere));
    const remedy =
      report.database.kind === "generated"
        ? "Configure the project again."
        : "This is your own compile database, so O3DE won't regenerate it: regenerate it, or fix those paths in it, yourself.";
    findings.push(
      `${plural(elsewhere, "include directory")} named in the database ${elsewhere === 1 ? "doesn't" : "don't"} exist on disk ${list(shown, elsewhere)}: ` +
        `a stale configure, a moved engine or a missing 3rd-party package. ${remedy}`,
    );
  }
  if (inBuildFolder > 0) {
    findings.push(
      `${plural(inBuildFolder, "include directory")} in the build folder ${inBuildFolder === 1 ? "doesn't" : "don't"} exist yet: a build creates ` +
        `${inBuildFolder === 1 ? "it" : "them"} (Qt's moc and ui headers, for one). Build the project once so clangd can see the generated headers.`,
    );
  }
  return findings;
}

function fileFindings(files: FileCheck[]): string[] {
  const findings: string[] = [];
  const checked = files.filter((file) => file.status === "ok" || file.status === "errors");
  const own = checked.filter((file) => file.command !== "inferred");
  const guessed = checked.filter((file) => file.command === "inferred");

  const ownErrors = own.filter((file) => file.status === "errors");
  if (ownErrors.length > 0) {
    findings.push(
      `${plural(ownErrors.length, "sampled file")} with an entry of ${ownErrors.length === 1 ? "its" : "their"} own still ` +
        `${ownErrors.length === 1 ? "shows" : "show"} compile errors (${names(ownErrors)}): an include path, define or flag is missing from the command.`,
    );
  }
  if (guessed.length > 0) {
    const guessedErrors = guessed.filter((file) => file.status === "errors");
    findings.push(
      `${plural(guessed.length, "sampled source")} ${guessed.length === 1 ? "has" : "have"} no entry in the database, so clangd guesses ` +
        `${guessed.length === 1 ? "its" : "their"} flags from another file` +
        (guessedErrors.length > 0
          ? `; ${count(guessedErrors.length)} of them ${guessedErrors.length === 1 ? "shows" : "show"} compile errors (${names(guessedErrors)}).`
          : ", and they compile without errors."),
    );
  }
  const slow = files.filter((file) => file.status === "timedOut" || file.status === "failed");
  if (slow.length > 0) {
    findings.push(`${plural(slow.length, "sampled file")} could not be checked (${names(slow)}): ${slow[0].note ?? "clangd did not finish."}`);
  }
  return findings;
}

/** What is wrong with the setup, and what to do - empty-handed means the sample is healthy. */
export function healthFindings(report: HealthReport): string[] {
  const findings: string[] = [];
  const { clangd, database, engine, partial } = report;

  if (!clangd.found) {
    findings.push(`${clangd.problem ?? "clangd was not found."} Install the clangd extension and let it download clangd, or set clangd.path.`);
  }
  if (!database.exists) {
    findings.push(`There is no compile database at ${database.file}. ${databaseRemedy(report)}`);
  } else if (database.problem) {
    findings.push(`${database.problem} ${databaseRemedy(report)}`);
  } else if (database.entries === 0) {
    findings.push(`The compile database ${database.file} has no entries, so clangd has no flags for any file. ${databaseRemedy(report)}`);
  }
  if (database.exists && database.entries > 0 && !database.inUse) {
    findings.push(
      "clangd.arguments doesn't point --compile-commands-dir at this database, so clangd in the editor doesn't read it (this check ran against it " +
        "anyway). Run O3DE: Select IntelliSense Engine and choose clangd.",
    );
  }
  if (report.intellisenseEngine !== "clangd" && report.intellisenseEngine !== "both") {
    findings.push("clangd isn't the running C++ IntelliSense engine in this workspace: this shows what clangd would do with the database.");
  }
  findings.push(...includeDirFindings(report));
  findings.push(...fileFindings(report.files));
  if (engine.hint) {
    findings.push(engine.hint);
  }
  if (partial) {
    findings.push(
      partial.reason === "cancelled"
        ? `The check was cancelled: ${plural(partial.skipped, "file")} ${partial.skipped === 1 ? "was" : "were"} not checked.`
        : `The time budget ran out: ${plural(partial.skipped, "file")} ${partial.skipped === 1 ? "was" : "were"} not checked. Ask for a smaller sample.`,
    );
  }
  if (findings.length === 0) {
    findings.push("No problems found in the sample: every checked file compiled without errors, using an entry of its own.");
  }
  return findings;
}

// ---- Summary line ----------------------------------------------------------
/** One line: the verdict on the sample, then the facts behind it. */
export function healthSummaryLine(report: HealthReport): string {
  const { summary, clangd, database } = report;
  const verdict =
    summary.sampled === 0
      ? clangd.found
        ? "no files were checked (the compile database has no usable entries)"
        : "no files were checked (clangd was not found)"
      : `${count(summary.clean)} of ${count(summary.sampled)} sampled files compile cleanly` +
        (summary.withErrors > 0 ? `, ${count(summary.withErrors)} with errors` : "") +
        (summary.notChecked > 0 ? `, ${count(summary.notChecked)} not checked` : "") +
        (summary.withoutEntry > 0 ? ` (${count(summary.withoutEntry)} had no entry)` : "");
  return (
    `IntelliSense health: ${verdict} · clangd ${clangd.version ?? "not found"} · ${count(database.entries)} database entries · ` +
    `${count(database.includeDirs.missing)} missing include dirs · engine ${report.engine.mode}`
  );
}

// ---- Markdown --------------------------------------------------------------
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");

const KIND_TEXT = { generated: "generated by O3DE", user: "your own, from o3de.intellisense.compileDatabase", clangdArguments: "named by clangd.arguments" };

const SOURCE_TEXT = { setting: "clangd.path", extension: "the clangd extension's download", path: "PATH" };

function fileRow(file: FileCheck): string {
  const flags = file.command === "entry" ? "own entry" : file.command === "inferred" ? `inferred from ${file.inferredFrom ?? "a neighbour"}` : "-";
  const result = file.status === "ok" ? "0" : file.status === "errors" ? String(file.errorCount) : file.status;
  return `| ${cell(file.file)} | ${ORIGIN_LABEL[file.origin]} | ${cell(flags)} | ${result} | ${file.seconds} |`;
}

/** The report as a Markdown document: findings first, then the facts. */
export function formatHealthReport(report: HealthReport): string {
  const { clangd, database, summary } = report;
  const lines: string[] = [
    "# O3DE IntelliSense health",
    "",
    `${report.project.name} - O3DE Development Tools ${report.extensionVersion} - ${report.platform}`,
    "",
    `**${healthSummaryLine(report)}**`,
    "",
    "## Findings",
    "",
    ...report.findings.map((finding) => `- ${finding}`),
    "",
    "## clangd",
    "",
    `- Version: ${clangd.version ?? "not found"}`,
    ...(clangd.path ? [`- Binary: ${clangd.path} (from ${clangd.source ? SOURCE_TEXT[clangd.source] : "unknown"})`] : []),
    `- C++ IntelliSense engine running: ${report.intellisenseEngine}`,
    ...(report.toolchain ? [`- Compiler in the database: ${report.toolchain.compiler} (${report.toolchain.style === "msvc" ? "MSVC" : "GNU"} switches)`] : []),
    "",
    "## Compile database",
    "",
    `- File: ${database.file} (${KIND_TEXT[database.kind]})`,
    `- clangd.arguments points at it: ${database.inUse ? "yes" : "no"}`,
    `- Entries: ${count(database.entries)} (${originsLine(database.origins)})`,
    ...(database.skippedManifestGems
      ? [`- Gems registered in the O3DE manifest and left out: ${count(database.skippedManifestGems)} (the project doesn't enable them and the workspace doesn't contain them)`]
      : []),
    `- Include directories not on disk: ${count(database.includeDirs.missing)} of ${count(database.includeDirs.checked)}` +
      (database.includeDirs.inBuildFolder > 0 ? `, ${count(database.includeDirs.inBuildFolder)} of them in the build folder (a build creates them)` : "") +
      (database.includeDirs.examples.length ? ` (${database.includeDirs.examples.join(", ")})` : ""),
    "",
    "## Engine",
    "",
    `- Mode: ${engineText(report)}`,
    `- Engine coverage setting: ${report.engine.coverage}`,
    ...(report.engine.hint ? [`- ${report.engine.hint}`] : []),
    "",
    `## Sampled files (${count(summary.sampled)})`,
    "",
  ];

  if (report.files.length === 0) {
    lines.push("No files were checked.", "");
  } else {
    lines.push("| File | Origin | Flags | Errors | Seconds |", "| --- | --- | --- | --- | --- |", ...report.files.map(fileRow), "");
    for (const file of report.files.filter((candidate) => candidate.firstErrors.length > 0 || candidate.note)) {
      lines.push(`**${file.file}**`, "");
      lines.push(...file.firstErrors.map((error) => `- ${error}`));
      if (file.errorCount > file.firstErrors.length) {
        lines.push(`- ... and ${count(file.errorCount - file.firstErrors.length)} more`);
      }
      if (file.note) {
        lines.push(`- ${file.note}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
