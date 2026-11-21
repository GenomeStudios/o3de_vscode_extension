// ============================================================================
//  MCP server implementation — the SDK-facing layer (lazy-loaded).
//
//  Everything that touches @modelcontextprotocol/sdk + zod lives here so the
//  public O3deMcpServer (server.ts) can `await import()` it ONLY when the user
//  opts into LLM connections — nothing here is loaded/evaluated otherwise.
//
//  Transport: a Node http server bound to 127.0.0.1 speaking MCP over Streamable
//  HTTP with session routing. A client's `initialize` mints a session id; the
//  client echoes it (mcp-session-id header) on every later request and we route
//  it to that session's transport. Every request must carry the bearer token.
//  Tools: health (o3de_ping), build (o3de_build, which can wait for the Editor to close + _status/_log), configure
//  (o3de_configure + _status), o3de_stop, run (o3de_is_running, o3de_run, o3de_run_debug, o3de_read_run_log),
//  config (o3de_get/set_config incl. CMake flags + launch-args history + the Visual Studio selection,
//  o3de_list_targets), Visual Studio (o3de_visual_studio_status),
//  and IntelliSense (o3de_intellisense_status, o3de_set_intellisense_engine, which also takes the user's own
//  compile database, o3de_update_clangd_database, and o3de_intellisense_health, which runs clangd --check on a
//  sample of files and streams progress while it does).
// ============================================================================

import * as http from "http";
import { basename } from "path";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { log } from "../log";
import { BuildOptions, BuildConfig, RunTarget } from "../build/buildOptions";
import { startBuildJob, getBuildJob } from "../build/buildJobs";
import { startConfigureJob, getConfigureJob } from "../build/configureJobs";
import { ConfigureResult } from "../build/configure";
import { cancelManagedCommand, managedJob } from "../build/managedCommand";
import { buildJobKey, configureJobKey } from "../build/jobKeys";
import { firstWorkspaceProject } from "../build/projectResolve";
import { BuildResult } from "../build/buildOutput";
import { describeWait, waitForProcessesToExit } from "../build/editorWait";
import { runningGuardedProcesses } from "../build/processGuard";
import { configSnapshot, applyConfig, listTargets } from "../build/configQuery";
import { visualStudioStatus } from "../env/visualStudioQuery";
import {
  runStatus,
  launchRunTarget,
  monitorLaunch,
  launchDebugTarget,
  readRunLog,
  forceCloseRuntime,
  RunLogReport,
} from "../build/runQuery";
import { MAX_TAIL_LINES } from "../build/runLog";
import { intellisenseReport, setIntelliSenseEngine, updateClangdDatabase } from "../intellisense/intellisenseQuery";
import { syncMessage } from "../intellisense/clangdSync";
import type { OriginCounts } from "../intellisense/databasePlan";
import { startHealthCheck } from "../intellisense/healthQuery";
import { DEFAULT_SAMPLE_SIZE, INLINE_BUDGET_MS, MAX_ENTRYLESS, MAX_SAMPLE_SIZE, MIN_SAMPLE_SIZE, TOTAL_BUDGET_MS } from "../intellisense/healthModel";
import { healthSummaryLine } from "../intellisense/healthReport";
import type { DatabaseSelection } from "../intellisense/userDatabase";
import type { Memento } from "vscode";

const MCP_PATH = "/mcp";
const HOST = "127.0.0.1";
const SESSION_HEADER = "mcp-session-id";

// o3de_build BLOCKS by default and returns the full result in one call. When the
// client sends a progressToken we hold the (SSE) response open up to MAX_BLOCK_MS,
// emitting progress heartbeats every HEARTBEAT_MS (which keep the client's timeout
// reset and stop any reverse proxy idle-killing the stream). Past the cap — or with
// no progressToken — it hands back a poll handle (o3de_build_status/o3de_build_log).
const MAX_BLOCK_MS = 20 * 60_000; // cap on a held-open (progress-streamed) build
const HEARTBEAT_MS = 5_000; // progress cadence while blocking
const INLINE_WAIT_MS = 20_000; // no progress token → short wait, then a handle
const DEFAULT_EDITOR_WAIT_MINUTES = 30; // o3de_build waitForEditorExit: how long to wait for the Editor to close

export interface McpHttpOptions {
  port: number;
  token: string;
  requireToken: boolean; // when false, the localhost bind is the only gate (no 401 → no OAuth cascade)
  allowForceClose: boolean; // expose the destructive o3de_force_close tool (opt-in)
  version: string;
  buildOptions: BuildOptions;
  workspaceState: Memento; // per-workspace store (the IntelliSense engine switch records prior settings here)
  globalStorageRoot?: string; // the folder holding every extension's global storage (where the clangd extension downloads clangd)
}

export interface McpHttpHandle {
  port: number;
  close(): Promise<void>;
}

// ---- Lifecycle -------------------------------------------------------------
/** Start the localhost MCP http server, resolving with the actual port + a closer. */
export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle> {
  // Live sessions for this server instance (cleared on close / restart).
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const server = http.createServer((req, res) => void handleRequest(req, res, opts, sessions));
  // A blocking o3de_build can hold its SSE response open for many minutes; Node's
  // default 5-min requestTimeout would sever it, so disable it. keepAliveTimeout is
  // per-connection idle between requests and doesn't cap an in-flight response.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  const port = await listen(server, opts.port);
  log().info(`LLM (MCP) endpoint listening on http://${HOST}:${port}${MCP_PATH}`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const transport of sessions.values()) {
          void transport.close();
        }
        sessions.clear();
        server.close(() => resolve());
      }),
  };
}

/**
 * Bind to the requested port on localhost. NO ephemeral fallback: the client's
 * .mcp.json is pasted once, so the port must be stable — a random fallback would
 * silently break the saved config. If the port is busy (usually a stale window
 * still holding it), fail with a clear, actionable error.
 */
function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("error", onError);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} is already in use — another O3DE window (or process) is holding it. ` +
              `Close extra windows, or change o3de.llm.port.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

// ---- Request handling ------------------------------------------------------
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: McpHttpOptions,
  sessions: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  const authOk = !opts.requireToken || req.headers["authorization"] === `Bearer ${opts.token}`;
  log().debug(`MCP ${req.method} ${path} — ${opts.requireToken ? (authOk ? "auth ok" : "bad/missing token") : "no-auth"}`);

  // Path FIRST, before any auth check. MCP clients probe OAuth discovery URLs
  // (e.g. /.well-known/oauth-protected-resource) on connect; a 401 there makes
  // the client think the server speaks OAuth and sends it into a broken auth
  // flow that stalls initialize. A 404 says "no OAuth here" → it just uses the
  // bearer header we configured and proceeds.
  if (path !== MCP_PATH && path !== `${MCP_PATH}/`) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  // Bearer auth for the MCP endpoint itself (localhost bind is not enough alone —
  // any local process could otherwise drive builds). Plain 401, no OAuth pointer.
  if (!authOk) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="o3de-development-tools"');
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const sessionId = req.headers[SESSION_HEADER] as string | undefined;
  const body = req.method === "POST" ? await readJsonBody(req).catch(() => INVALID_BODY) : undefined;
  if (body === INVALID_BODY) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  let transport: StreamableHTTPServerTransport;
  if (sessionId && sessions.has(sessionId)) {
    // Existing session — route to its transport (POST calls, GET stream, DELETE).
    transport = sessions.get(sessionId)!;
  } else if (!sessionId && req.method === "POST" && isInitialize(body)) {
    // New session — the initialize handshake mints an id we hand back to the client.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // SSE mode (not enableJsonResponse) so a blocking o3de_build can stream
      // notifications/progress heartbeats while the build runs.
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    await buildMcpServer(opts).connect(transport);
  } else {
    sendJson(res, 400, { error: "no valid MCP session — send an initialize request first" });
    return;
  }

  await transport.handleRequest(req, res, body);
}

const INVALID_BODY = Symbol("invalid-body");

function isInitialize(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && (body as { method?: string }).method === "initialize";
}

// ---- Tool registration -----------------------------------------------------
function buildMcpServer(opts: McpHttpOptions): McpServer {
  const server = new McpServer({ name: "o3de-development-tools", version: opts.version });

  server.registerTool(
    "o3de_ping",
    {
      title: "O3DE Ping",
      description: "Health check — confirms the O3DE Development Tools MCP endpoint is live and reachable.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text" as const, text: `O3DE Development Tools ${opts.version} — ready` }] }),
  );

  server.registerTool(
    "o3de_build",
    {
      title: "O3DE Build",
      description:
        "Build the O3DE project (cmake --build) and return structured pass/fail plus parsed compiler/linker " +
        "diagnostics — so you can compile a change and react to the errors. Windows/MSVC only. The Editor must " +
        "be CLOSED (a running Editor locks gem DLLs and the link step fails; reports blocked:editor-running if so). " +
        "Pass waitForEditorExit:true to wait for the Editor to be closed and then build, instead of refusing: " +
        "it waits up to maxWaitMinutes (default 30), streaming progress, and reports blocked:editor-running if it " +
        "is still open. A client that sends no progress token waits only ~20s, so it should ask the user to close " +
        "the Editor and call again. Ask the user before waiting on an Editor they may be using; cancelling the call " +
        "stops the wait without building. " +
        "This BLOCKS until the build finishes and returns the full result in one call (progress is streamed while " +
        "it runs) — no polling needed in the normal case. Only if a build exceeds ~20 min does it return a buildId " +
        "with state:running, after which you poll o3de_build_status then o3de_build_log. The finished result is also " +
        "written to <project>/user/o3de-build-result.json. Targets/config default to the O3DE panel selection.",
      inputSchema: {
        targets: z
          .array(z.string())
          .optional()
          .describe('CMake target names, e.g. ["Editor"]. Omit to use the panel selection; [] builds everything.'),
        config: z
          .enum(["profile", "debug", "release"])
          .optional()
          .describe("Build configuration. Omit to use the panel selection."),
        waitForEditorExit: z
          .boolean()
          .optional()
          .describe("If the Editor (or Script Canvas) is running, wait for it to close and then build, instead of returning blocked:editor-running."),
        maxWaitMinutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe(`With waitForEditorExit: the longest to wait for the Editor to close, in minutes (default ${DEFAULT_EDITOR_WAIT_MINUTES}).`),
      },
    },
    async (args: { targets?: string[]; config?: BuildConfig; waitForEditorExit?: boolean; maxWaitMinutes?: number }, extra) => {
      const config = args.config ?? opts.buildOptions.config;
      const targets = args.targets ?? opts.buildOptions.targets;

      // The wait and the build are one call, so they share one progress count (MCP progress must keep increasing).
      const progress: ProgressCounter = { step: 0 };

      // Nothing to wait for without a project, or when a build is already running (this call just joins it).
      if (args.waitForEditorExit && firstWorkspaceProject() && getBuildJob()?.state !== "running") {
        const refusal = await waitForEditorExit(extra, args.maxWaitMinutes ?? DEFAULT_EDITOR_WAIT_MINUTES, progress);
        if (refusal) {
          return buildResultContent(editorRunningResult(config, targets, refusal));
        }
      }

      const job = startBuildJob({ generator: opts.buildOptions.generator, config, targets, coreCount: opts.buildOptions.coreCount });

      // Block until done, streaming progress heartbeats if the client gave us a token (see holdUntilDone).
      const started = Date.now();
      await holdUntilDone(extra, job, (elapsed) => `Building ${config}… ${elapsed}s elapsed`, progress);

      if (job.result) {
        return buildResultContent(job.result); // finished — return the full result inline
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Build started — id ${job.buildId} (config ${config}, targets [${targets.join(", ") || "all"}]). ` +
              `Still running after ${Math.round((Date.now() - started) / 1000)}s; this is normal for a full build. ` +
              `Poll o3de_build_status until state:done, then o3de_build_log for the structured result ` +
              `(both default to the latest build — no argument needed). It's also written to ` +
              `${job.resultPath ?? "<project>/user/o3de-build-result.json"} when finished.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "o3de_build_status",
    {
      title: "O3DE Build Status",
      description:
        "Check whether the most recent o3de_build is still running or finished, with elapsed time and a one-line " +
        "summary. Poll this after o3de_build returns state:running. Defaults to the latest build.",
      inputSchema: { buildId: z.string().optional().describe("Omit for the latest build.") },
    },
    async (args: { buildId?: string }) => {
      const job = getBuildJob(args.buildId);
      if (!job) {
        return { content: [{ type: "text" as const, text: "No build has been started this session." }] };
      }
      const elapsed = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
      const status = {
        buildId: job.buildId,
        state: job.state,
        config: job.params.config,
        targets: job.params.targets,
        elapsedSeconds: elapsed,
        ok: job.result?.ok,
        blocked: job.result?.blocked,
        summary: job.result?.summary,
        resultPath: job.resultPath,
      };
      const line = job.state === "done" ? job.result?.summary ?? "done" : `Building… (${elapsed}s elapsed)`;
      return { content: [{ type: "text" as const, text: line }, { type: "text" as const, text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    "o3de_build_log",
    {
      title: "O3DE Build Log",
      description:
        "Get the full structured result of the most recent o3de_build once it has finished: pass/fail, parsed " +
        "compiler/linker errors and warnings (file:line:code), the exact command, and the tail of raw output. " +
        "Defaults to the latest build.",
      inputSchema: { buildId: z.string().optional().describe("Omit for the latest build.") },
    },
    async (args: { buildId?: string }) => {
      const job = getBuildJob(args.buildId);
      if (!job) {
        return { content: [{ type: "text" as const, text: "No build has been started this session." }] };
      }
      if (job.state !== "done" || !job.result) {
        const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
        return {
          content: [
            { type: "text" as const, text: `Build ${job.buildId} is still running (${elapsed}s). Poll o3de_build_status until state:done.` },
          ],
        };
      }
      return buildResultContent(job.result);
    },
  );

  // ---- Configure: headless configure + status, and stopping jobs ----------
  server.registerTool(
    "o3de_configure",
    {
      title: "O3DE Configure",
      description:
        "Run the CMake configure for the workspace project (the same as the O3DE panel's Configure) with the selected " +
        "generator and compiler, passing the Advanced tab's CMake flags (see o3de_get_config cmakeFlags). Needed on first " +
        "setup, after changing CMake flags or build files, or when o3de_build reports blocked:not-configured. Never prompts: " +
        "if the build tree was configured with a different generator it returns blocked:generator-mismatch instead of " +
        "clearing the CMake cache (ask the user). On Windows the compiler environment comes from the selected Visual Studio " +
        "(o3de_visual_studio_status); a build tree configured with a different one logs a warning and keeps its compiler. " +
        "Refuses while a build or configure runs (blocked:busy). BLOCKS until done " +
        "with progress streamed; a very long first configure (3rd-party downloads) returns a configureId with " +
        "state:running — poll o3de_configure_status. The result is also written to <project>/user/o3de-configure-result.json.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_args, extra) => {
      const job = startConfigureJob({ generator: opts.buildOptions.generator, compiler: opts.buildOptions.compiler });
      await holdUntilDone(extra, job, (elapsed) => `Configuring… ${elapsed}s elapsed`);
      if (job.result) {
        return configureResultContent(job.result);
      }
      const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
      return {
        content: [
          txt(
            `Configure started — id ${job.configureId}, still running after ${elapsed}s (normal when 3rd-party packages download). ` +
              "Poll o3de_configure_status until state:done.",
          ),
        ],
      };
    },
  );

  server.registerTool(
    "o3de_configure_status",
    {
      title: "O3DE Configure Status",
      description:
        "Whether the most recent configure started by o3de_configure is still running, and its full result once done: " +
        "pass/fail, CMake errors and warnings, the exact cmake command, and the tail of its output.",
      inputSchema: { configureId: z.string().optional().describe("Omit for the latest configure.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { configureId?: string }) => {
      const job = getConfigureJob(args.configureId);
      if (!job) {
        return { content: [txt("No configure has been started through MCP this session.")] };
      }
      if (!job.result) {
        const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
        return { content: [txt(`Configure ${job.configureId} is still running (${elapsed}s).`)] };
      }
      return configureResultContent(job.result);
    },
  );

  server.registerTool(
    "o3de_stop",
    {
      title: "O3DE Stop Build or Configure",
      description:
        "Stop the running build or configure for the workspace project, killing its whole process tree — the panel's Stop " +
        "button. It stops the job whoever started it (the user, o3de_build or o3de_configure), so ask the user before " +
        "stopping one they started.",
      inputSchema: { job: z.enum(["build", "configure"]).describe("Which job to stop.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: { job: "build" | "configure" }) => {
      const project = firstWorkspaceProject();
      if (!project) {
        return { content: [txt("No O3DE project in this workspace.")], isError: true };
      }
      const key = args.job === "build" ? buildJobKey(project.path) : configureJobKey(project.path);
      if (!managedJob(key)) {
        return { content: [txt(`No ${args.job} is running for ${project.projectName}.`), txt(JSON.stringify({ stopped: false }, null, 2))] };
      }
      const stopped = await cancelManagedCommand(key);
      const line = stopped ? `Stopped the ${args.job} for ${project.projectName}.` : `Could not stop the ${args.job}.`;
      return { content: [txt(line), txt(JSON.stringify({ stopped }, null, 2))] };
    },
  );

  // ---- Run: is-running probe + launch (no force-close) ---------------------
  server.registerTool(
    "o3de_is_running",
    {
      title: "O3DE Is Running",
      description:
        "Check whether the O3DE Editor or GameLauncher is currently running for the workspace project — WITHOUT " +
        "building. A running Editor locks the gem DLLs, so o3de_build fails the link with blocked:editor-running " +
        "(o3de_build waitForEditorExit waits for the user to close it first); " +
        "call this first to know the app's state (and after o3de_run to confirm it came up). Detects both apps this " +
        "extension launched and any started outside it (tasklist). Returns running true/false plus the images checked.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const status = await runStatus(opts.buildOptions);
      const line = status.note
        ? status.note
        : status.running
          ? `Running (${status.trackedLabel ?? status.images.join(", ")})`
          : "Not running";
      return { content: [txt(line), txt(JSON.stringify(status, null, 2))] };
    },
  );

  server.registerTool(
    "o3de_run",
    {
      title: "O3DE Run",
      description:
        "Launch the run target (Editor, GameLauncher, or any executable CMake target) detached — the 'run' half of " +
        "a build-and-run flow — using the O3DE panel's run target, config, and launch args unless overridden. " +
        "Returns immediately unless settleSeconds is set; use o3de_is_running to confirm it is up. With " +
        "settleSeconds (1-30) it waits that long for the app to exit and returns monitor: state " +
        "running|exited, waitedSeconds, and the tail of the target's log (null for a custom exe). stale:true means " +
        "that log was last written before this launch, so its lines are from an earlier run. monitor.errorLog (the " +
        "tail of error.log) is present only when error.log was written since this launch: the app hit a fatal error. " +
        "A crashed Editor can stay alive on its crash dialog, so state running alone does not mean the launch " +
        "survived. There is no exit code (the app is detached, its output is not captured) — read more with " +
        "o3de_read_run_log. The exe " +
        "must be built first (o3de_build the run target). If an app is already running for the project it is left " +
        "alone (alreadyRunning) — this tool never force-closes a running app; stopping stays a user action in the " +
        "O3DE panel. Windows/MSVC only.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe(
            "Run target to launch: 'Editor', 'GameLauncher', or any executable CMake target name " +
              "(see o3de_list_targets executables). Omit to use the panel selection.",
          ),
        config: z
          .enum(["profile", "debug", "release"])
          .optional()
          .describe("Build config to run. Omit to use the panel selection."),
        settleSeconds: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe("Seconds to wait after launching for an early exit, then report state + log tail. Default 0: return at once."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args: { target?: RunTarget; config?: BuildConfig; settleSeconds?: number }, extra) => {
      const launchedAt = Date.now();
      const result = launchRunTarget(opts.buildOptions, { target: args.target, config: args.config });

      // Optional settle: hold briefly after a successful launch, then say whether it is still up (see monitorLaunch).
      const settleSeconds = args.settleSeconds ?? 0;
      const project = result.launched && settleSeconds > 0 ? firstWorkspaceProject() : undefined;
      const monitor = project ? await monitorLaunch(project.path, result.target, settleSeconds, launchedAt, extra.signal) : undefined;

      const launchLine = `Launched ${result.target} (${result.config}, pid ${result.pid}).`;
      const monitorLine = monitor
        ? ` ${monitor.state === "running" ? "Still running" : "Exited"} after ${monitor.waitedSeconds}s.` +
          (monitor.stale ? " Its log was last written before this launch." : "") +
          (monitor.errorLog ? " error.log was written since this launch: the app hit a fatal error and may be waiting on a crash dialog." : "")
        : "";
      const line = result.launched
        ? launchLine + monitorLine
        : result.alreadyRunning
          ? `${result.target} already running — left alone.`
          : `Did not launch: ${result.reason}`;
      return {
        content: [txt(line), txt(JSON.stringify(monitor ? { ...result, monitor } : result, null, 2))],
        // alreadyRunning is a valid, non-error outcome; only a genuine failure is an error. A launched app that
        // exited within the settle time is a reported result, not a tool error.
        isError: !result.launched && !result.alreadyRunning,
      };
    },
  );

  server.registerTool(
    "o3de_run_debug",
    {
      title: "O3DE Run in Debug",
      description:
        "Launch the run target (Editor, GameLauncher, or any executable CMake target) under VS Code's C++ debugger — " +
        "the dashboard's Run in Debug — using the O3DE panel's run target, config, and launch args unless overridden, " +
        "so the user's breakpoints hit. Needs the Microsoft C/C++ extension (ms-vscode.cpptools; Microsoft marketplace " +
        "only, so absent in VSCodium / Open VSX editors / Cursor); without it the result is blocked:no-debugger and this " +
        "tool never installs it. The exe must be built first (o3de_build the run target; config 'debug' or 'profile' " +
        "for symbols). Returns once the debug session has started (it does not wait for the app to exit) with the " +
        "session and debugType. The debuggee's output goes to VS Code's terminal, not to this call — read the logs with " +
        "o3de_read_run_log. If that exe is already running, or another debug start is in progress, it is left alone " +
        "(blocked:already-running); this tool never " +
        "closes anything. Stopping the session is the user's Debug toolbar (or o3de_force_close when enabled).",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe(
            "Run target to debug: 'Editor', 'GameLauncher', or any executable CMake target name " +
              "(see o3de_list_targets executables). Omit to use the panel selection.",
          ),
        config: z
          .enum(["profile", "debug", "release"])
          .optional()
          .describe("Build config to debug. Omit to use the panel selection."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args: { target?: RunTarget; config?: BuildConfig }) => {
      const result = await launchDebugTarget(opts.buildOptions, { target: args.target, config: args.config });
      const line = result.started
        ? `Started ${result.target} (${result.config}) under the ${result.debugType} debugger.`
        : result.blocked === "already-running"
          ? `${result.target} already running — left alone.`
          : `Did not start (${result.blocked}): ${result.reason}`;
      return {
        content: [txt(line), txt(JSON.stringify(result, null, 2))],
        // already-running is a valid, non-error outcome; every other refusal is an error.
        isError: !result.started && result.blocked !== "already-running",
      };
    },
  );

  server.registerTool(
    "o3de_read_run_log",
    {
      title: "O3DE Read Run Log",
      description:
        "Read the end of one of the workspace project's O3DE logs from <project>/user/log: Editor.log (the Editor), " +
        "Game.log (the GameLauncher) or error.log (crash / fatal output). Use it after o3de_run or o3de_run_debug to see " +
        "whether the app came up or why it died; the app's own console output is not captured anywhere else. Works " +
        "while the app is still running. Returns the last tailLines lines (default 100, max 500; the text is also " +
        "capped at about 48,000 characters, most recent kept, with truncated:true when that cut lines you asked for), " +
        "plus modifiedAt and ageSeconds — check them to tell whether the log is from the current run. exists:false " +
        "means the app has not written that log yet. log 'auto' picks the log of the selected run target.",
      inputSchema: {
        log: z
          .enum(["auto", "editor", "game", "error"])
          .optional()
          .describe("Which log: editor = Editor.log, game = Game.log, error = error.log. Default 'auto' (the run target's log)."),
        tailLines: z
          .number()
          .int()
          .min(1)
          .max(MAX_TAIL_LINES)
          .optional()
          .describe(`How many lines from the end of the log. Default 100, max ${MAX_TAIL_LINES}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { log?: "auto" | "editor" | "game" | "error"; tailLines?: number }) => {
      const report = readRunLog(opts.buildOptions, { log: args.log, tailLines: args.tailLines });
      return { content: [txt(runLogSummary(report)), txt(JSON.stringify(report, null, 2))] };
    },
  );

  // Force-close is DESTRUCTIVE and opt-in: registered only when the user has set
  // o3de.llm.allowForceClose, and annotated destructive so the client asks before
  // every call. Intended flow: o3de_is_running -> (ask the user) -> o3de_force_close
  // -> o3de_build -> o3de_run. It kills the Editor/AssetProcessor that lock gem DLLs.
  if (opts.allowForceClose) {
    server.registerTool(
      "o3de_force_close",
      {
        title: "O3DE Force-Close App",
        description:
          "Force-quit the O3DE runtime (Editor, GameLauncher, AssetProcessor, ScriptCanvas) for the workspace " +
          "project — so a build can link when a running Editor is holding gem DLLs. DESTRUCTIVE: it kills the apps " +
          "and their child process trees, losing any unsaved Editor work. Always ask the user for explicit " +
          "permission before calling this. Typical flow: o3de_is_running -> confirm with the user -> o3de_force_close " +
          "-> o3de_build -> o3de_run. Windows only.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async () => {
        const result = await forceCloseRuntime();
        const line = result.note ?? `Force-closed O3DE runtime${result.closedTracked ? " (tracked app + tree)" : ""}.`;
        return { content: [txt(line), txt(JSON.stringify(result, null, 2))] };
      },
    );
  }

  // ---- Config get / set + target discovery ---------------------------------
  server.registerTool(
    "o3de_get_config",
    {
      title: "O3DE Get Config",
      description:
        "Read the current O3DE build options — generator, compiler, build config, selected targets, run target, " +
        "launch args (with launchArgsHistory, the remembered launch args, most recent first), parallel core count — plus " +
        "the valid choices for each and the resolved project + build directory. " +
        "cmakeFlags lists the Advanced tab's extra CMake cache variables, each with its stored value, what CMakeCache.txt " +
        "holds, and whether it's applied; cmakeFlags.pending true means o3de_configure is needed for them to take effect. " +
        "A cmakeFlags LY_3RDPARTY_PATH replaces the O3DE manifest's default 3rd-party path for o3de_configure. " +
        "On Windows, visualStudio reports which Visual Studio's MSVC environment configure and build use: the preference " +
        "(auto = the newest installed, or a pinned year), what it resolves to now, and the choices. " +
        "Use this before o3de_set_config, o3de_configure or o3de_build.",
      inputSchema: {},
    },
    async () => {
      const snap = configSnapshot(opts.buildOptions);
      const line = `config=${snap.config}, generator=${snap.generator}, compiler=${snap.compiler}, targets=[${snap.targets.join(", ") || "all"}], runTarget=${snap.runTarget}`;
      return { content: [txt(line), txt(JSON.stringify(snap, null, 2))] };
    },
  );

  server.registerTool(
    "o3de_set_config",
    {
      title: "O3DE Set Config",
      description:
        "Change one or more O3DE build options (the same state the panel shows and that o3de_build/o3de_run use). " +
        "Only the fields you pass change; others are left alone. Returns the updated config. cmakeFlags edits the Advanced " +
        "tab's CMake cache variables for the project (a value sets one; an empty string or null removes it; unlisted flags " +
        "are kept) — they take effect on the next o3de_configure; a LY_3RDPARTY_PATH flag replaces the O3DE manifest's " +
        "default 3rd-party path. launchArgs is also remembered in the launch-args history (o3de_get_config launchArgsHistory); " +
        "launchArgsHistory replaces that history, applied after launchArgs. " +
        "visualStudio (Windows only; an error elsewhere) selects which Visual Studio's MSVC environment configure, build " +
        "and the O3DE Developer terminal use: 'auto' = the newest installed with C++ tools, or a year to pin one " +
        "(a newly installed Visual Studio then never takes over). It is saved to the USER settings, and the result " +
        "reports the value actually in force: a workspace or folder value of o3de.build.visualStudio overrides it. A build " +
        "tree keeps the compiler it was configured with, so switching an existing tree also needs " +
        "<project>/build/windows/CMakeCache.txt and CMakeFiles deleted before o3de_configure (o3de_configure never clears them; " +
        "o3de_visual_studio_status reports configuredWith.mismatch). " +
        "Changing the generator also needs o3de_configure before the next build.",
      inputSchema: {
        generator: z.enum(["Ninja Multi-Config", "Visual Studio 17 2022"]).optional(),
        compiler: z.enum(["MSVC", "Clang"]).optional(),
        config: z.enum(["profile", "debug", "release"]).optional(),
        targets: z
          .array(z.string())
          .optional()
          .describe("CMake target names to build by default; [] = build everything."),
        runTarget: z
          .string()
          .optional()
          .describe(
            "'Editor', 'GameLauncher', or any executable CMake target name (see o3de_list_targets executables).",
          ),
        launchArgs: z
          .string()
          .optional()
          .describe("Extra args passed when running (blank to clear). Also recorded into the launch-args history."),
        launchArgsHistory: z
          .array(z.string())
          .optional()
          .describe(
            "Replace the remembered launch args (most recent first, at most 10); [] forgets them all. " +
              "Applied after launchArgs, so it overrides the entry launchArgs just recorded.",
          ),
        coreCount: z.number().int().min(0).optional().describe("Parallel build jobs; 0 = let the generator decide."),
        visualStudio: z
          .enum(["auto", "2019", "2022", "2026"])
          .optional()
          .describe("Windows only. 'auto' = newest Visual Studio with C++ tools; a year pins that Visual Studio."),
        cmakeFlags: z
          .record(z.string(), z.string().nullable())
          .optional()
          .describe('CMake cache variables, e.g. {"LY_RENDERDOC_ENABLED": "ON"}; an empty string or null removes one.'),
      },
    },
    async (args) => {
      let applied: string[];
      try {
        applied = await applyConfig(opts.buildOptions, args);
      } catch (err) {
        return { content: [txt(`Not changed: ${(err as Error).message}`)], isError: true };
      }
      const snap = configSnapshot(opts.buildOptions);
      if (applied.length) {
        log().info(
          `MCP o3de_set_config: ${applied.join(", ")} -> config=${snap.config}, runTarget=${snap.runTarget}, targets=[${snap.targets.join(", ") || "all"}]`,
        );
      }
      const pending = snap.cmakeFlags?.pending ? " CMake flags aren't applied yet — run o3de_configure for them to take effect." : "";
      const vs = snap.visualStudio;
      const overridden =
        args.visualStudio !== undefined && vs && vs.preference !== args.visualStudio
          ? ` Visual Studio '${args.visualStudio}' was saved to the user settings, but the ${vs.overriddenBy} value of o3de.build.visualStudio overrides it: '${vs.preference}' is in force.`
          : "";
      const line = applied.length ? `Updated: ${applied.join(", ")}.${pending}${overridden}` : "No changes — no fields provided.";
      return { content: [txt(line), txt(JSON.stringify(snap, null, 2))] };
    },
  );

  server.registerTool(
    "o3de_list_targets",
    {
      title: "O3DE List Targets",
      description:
        "List every buildable CMake target for a config (from the CMake File API reply) so you can build a specific " +
        "gem/target purposefully — beyond the panel's default selection. Pass a name from here to o3de_build (or " +
        "o3de_set_config targets). The `executables` field lists the runnable subset — valid o3de_run / runTarget " +
        "values. Requires the project to have been configured at least once.",
      inputSchema: { config: z.enum(["profile", "debug", "release"]).optional().describe("Omit for the current config.") },
    },
    async (args: { config?: BuildConfig }) => {
      const list = listTargets(opts.buildOptions, args.config);
      const line = list.configured
        ? `${list.targets.length} target(s) for ${list.config}`
        : list.note ?? "not configured";
      return { content: [txt(line), txt(JSON.stringify(list, null, 2))] };
    },
  );

  // ---- Visual Studio: status -------------------------------------------------
  server.registerTool(
    "o3de_visual_studio_status",
    {
      title: "O3DE Visual Studio Status",
      description:
        "Report which Visual Studio (MSVC) configure, build and the O3DE Developer terminal use — the dashboard's " +
        "Visual Studio row and the onboarding row, from the same code. Returns the selection preference " +
        "(o3de.build.visualStudio: 'auto' = the newest install with C++ tools, or a pinned year), every detected install " +
        "(displayName, version, year, installationPath, hasCppTools, selected), the selected one, and a problem when the " +
        "selection is unusable (a pinned year that is not installed, or no C++ tools). invalidSetting appears when the " +
        "setting holds something that is not auto or a pinnable year: it is ignored and read as auto. configuredWith shows the compiler the " +
        "project's build tree cached and whether it lies outside the selected install (mismatch:true = the build tree was " +
        "configured with a different Visual Studio; it keeps that compiler until CMakeCache.txt and CMakeFiles are deleted and " +
        "o3de_configure runs). inheritedEnvironment appears when VS Code itself was started from a Visual Studio developer " +
        "prompt; those variables are ignored only while a year is pinned. captureEnvironment:true also runs vcvars (1-2 s) and " +
        "returns the VCToolsVersion, VCToolsInstallDir, VSINSTALLDIR and cl.exe path a build receives — the O3DE: Open " +
        "Developer Terminal command and the \"O3DE Developer (MSVC)\" terminal profile start with exactly this " +
        "environment (there is no tool to open a terminal: it is a GUI affordance an assistant cannot type into, so " +
        "this reports what it gets, and o3de_build / o3de_configure run with the same environment). Change the " +
        "selection with o3de_set_config visualStudio. Windows only (supported:false elsewhere).",
      inputSchema: {
        captureEnvironment: z
          .boolean()
          .optional()
          .describe("Also capture the MSVC environment a build receives (runs vcvars, 1-2 s). Default false."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { captureEnvironment?: boolean }) => {
      const status = await visualStudioStatus({ captureEnvironment: args.captureEnvironment });
      const line = !status.supported
        ? status.problem ?? "Visual Studio selection is Windows-only."
        : `Visual Studio: ${status.selected ? status.selected.displayName : "none selected"} (preference ${status.preference})` +
          (status.problem ? ` — ${status.problem}` : "") +
          (status.configuredWith?.mismatch ? " — the build tree was configured with a different Visual Studio." : "");
      return { content: [txt(line), txt(JSON.stringify(status, null, 2))] };
    },
  );

  // ---- IntelliSense: status + engine switch --------------------------------
  server.registerTool(
    "o3de_intellisense_status",
    {
      title: "O3DE IntelliSense Status",
      description:
        "Report C++ and Lua IntelliSense state for the workspace project — the same answers as the dashboard's " +
        "IntelliSense section: which C++ IntelliSense engine is running (the Microsoft C/C++ extension, clangd, both, " +
        "or none) and whether a window reload is still needed to stop the C/C++ extension; clangdOnly (no C/C++ " +
        "extension, clangd installed — O3DE then switches clangd on automatically, once per workspace); whether the C/C++ and " +
        "clangd extensions are installed (with versions, and whether clangd's language server has been downloaded); " +
        "while clangd uses O3DE's compile database, whether that database is current (clangdDatabase: upToDate / " +
        "updatePending / notConfigured / noProject, with entry counts by origin in last.origins — project, gem, " +
        "engineFramework, engineGems (the engine gems the project uses) and fallback (gem sources no configured target " +
        "lists) — last.engineEntries engine sources, of which last.engineModuleDefines carry their module's export " +
        "defines, last.engineCoverage, and last.skippedManifestGems (gems registered in the o3de manifest that the project " +
        "neither enables nor the workspace contains, so they are left out); last is this session's most recent generation " +
        "and says nothing about the user's own database when the state is userProvided; notInUse otherwise); which " +
        "compile database is selected and why " +
        "(clangdDatabase.selection: source 'generated' = O3DE generates it, or 'user' = the user's own compile_commands.json " +
        "named by the o3de.intellisense.compileDatabase setting, which O3DE never writes — state userProvided once clangd " +
        "reads it; selection.missing when the setting names nothing usable, so O3DE falls back to generating; " +
        "selection.hint when the setting is empty but a compile_commands.json exists in the project or its build folder, " +
        "which O3DE never switches to by itself); engineCoverage, the o3de.intellisense.engineCoverage " +
        "setting (participating / framework / off) that decides how much engine source the generated database holds; " +
        "how far navigation reaches into engine code (engineSources: native / redirected / headersOnly / unresolved); " +
        "whether C++ data is stale and needs a reconfigure (cppData); and whether Lua reflection is stale (luaReflection).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const report = await intellisenseReport(opts.buildOptions);
      const line =
        `Engine: ${report.engine.label}${report.engine.cppToolsStopsAfterReload ? " (reload pending)" : ""} · ` +
        `C/C++ ${report.extensions.cppTools.installed ? "installed" : "not installed"} · ` +
        `clangd ${report.extensions.clangd.installed ? (report.extensions.clangd.server.found ? "installed" : "installed, server not found") : "not installed"} · ` +
        (report.clangdDatabase.state === "notInUse" ? "" : `clangd database: ${report.clangdDatabase.label} · `) +
        compileDatabaseLine(report.clangdDatabase.selection) +
        `Engine sources: ${report.engineSources.label} (coverage ${report.engineCoverage.setting}) · C++ data: ${report.cppData.label} · Lua: ${report.luaReflection.label}`;
      return { content: [txt(line), txt(JSON.stringify(report, null, 2))] };
    },
  );

  server.registerTool(
    "o3de_set_intellisense_engine",
    {
      title: "O3DE Set IntelliSense Engine",
      description:
        "Choose which C++ IntelliSense engine runs for this workspace — 'cpptools' (the Microsoft C/C++ extension) or " +
        "'clangd' — and switch the other off. Same as clicking IntelliSense Engine on the dashboard. 'clangd' first " +
        "generates O3DE's compile database from the project's CMake configure (the project must be configured), turns " +
        "C/C++ IntelliSense off and clangd on, and restarts clangd. 'cpptools' restores the settings O3DE changed and " +
        "shuts clangd down. Writes WORKSPACE settings only and is reversible. Never installs an extension: a missing one " +
        "returns reason notInstalled (check o3de_intellisense_status first). When the result has reloadRequired:true, " +
        "tell the user to reload the window — the C/C++ extension only stops its IntelliSense after a reload. If " +
        "clangd's language server hasn't been downloaded yet, clangd asks the user to download it. " +
        "compileDatabase brings the user's own compile database: a compile_commands.json, or the folder holding one " +
        "(absolute, or relative to the project), stored as the workspace-folder setting o3de.intellisense.compileDatabase " +
        "before the switch; '' removes the workspace-folder value (back to the generated database unless a User or Workspace " +
        "value still applies: the result says which database is read). clangd is then pointed at the user's folder and O3DE " +
        "never writes it (no generation, no sync, no engine coverage). A path with no compile_commands.json is not " +
        "an error: the result's compileDatabase.missing says so and O3DE falls back to the generated database. The result's " +
        "compileDatabase.source says which database clangd reads ('generated' or 'user') and why. Omit compileDatabase to " +
        "leave the setting as it is. Changing the setting while clangd already runs on a database O3DE pointed it at " +
        "re-points clangd by itself (only when clangd is the sole running engine), so calling this with the same engine " +
        "'clangd' and a new compileDatabase also works. The setting stays stored even when the switch fails (for instance " +
        "reason notConfigured): the failure result then carries settingWritten:true and the compileDatabase selection.",
      inputSchema: {
        engine: z.enum(["cpptools", "clangd"]).describe("'cpptools' = Microsoft C/C++ extension; 'clangd' = clangd."),
        compileDatabase: z
          .string()
          .optional()
          .describe(
            "The user's own compile database: a compile_commands.json, or its folder (absolute, or relative to the project). " +
              "'' removes the workspace-folder value (the generated database, unless a User or Workspace value still applies; " +
              "the result says which database is read). Omit to leave the setting as it is.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: { engine: "cpptools" | "clangd"; compileDatabase?: string }) => {
      const result = await setIntelliSenseEngine(opts.buildOptions, opts.workspaceState, args.engine, args.compileDatabase);
      const databaseNote = compileDatabaseNote(result.compileDatabase); // on a failure too: the setting may be stored already
      const line = !result.ok
        ? `Not switched (${result.reason}): ${result.message}${databaseNote ? ` ${databaseNote}` : ""}`
        :`IntelliSense engine set to ${result.engine}; running now: ${result.running}.` +
          (result.database
            ? ` Compile database: ${result.database.entries} entries (${originsLine(result.database.origins)}; ` +
              `${result.database.engineModuleDefines} engine with module export defines; engine coverage ${result.database.engineCoverage}).`
            : "") +
          (databaseNote ? ` ${databaseNote}` : "") +
          (result.reloadRequired ? " Reload the window to stop the C/C++ extension's IntelliSense." : "");
      return { content: [txt(line), txt(JSON.stringify(result, null, 2))], isError: !result.ok };
    },
  );

  server.registerTool(
    "o3de_update_clangd_database",
    {
      title: "O3DE Update clangd Compile Database",
      description:
        "Regenerate O3DE's compile database for clangd now, from the project's last CMake configure and the current " +
        "build config. It already updates itself after a configure, a build-config switch, a workspace folder change " +
        "and at startup — call this only when o3de_intellisense_status reports clangdDatabase updatePending, or after " +
        "changing engine sources the configure doesn't track. Only acts while clangd uses O3DE's database (ran:false " +
        "otherwise). clangd restarts only when the content changed. A source file added in CMake needs a reconfigure " +
        "first — this tool doesn't configure. engineCoverage overrides the o3de.intellisense.engineCoverage setting " +
        "for this one run: 'participating' (engine Framework + the engine gems the project uses), 'framework' " +
        "(Framework only) or 'off' (no engine sources); the next automatic update goes back to the setting. The " +
        "result's generation.origins counts the entries by origin. While clangd reads the user's own compile database " +
        "(o3de.intellisense.compileDatabase) this tool does nothing: ran:false, reason userDatabase — O3DE never writes it.",
      inputSchema: {
        engineCoverage: z
          .enum(["participating", "framework", "off"])
          .optional()
          .describe("Override the engine coverage setting for this run only; omit to use the setting."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: { engineCoverage?: "participating" | "framework" | "off" }) => {
      const outcome = await updateClangdDatabase(opts.buildOptions, args.engineCoverage);
      const failed = outcome.ran && !outcome.generation.ok;
      return { content: [txt(syncMessage(outcome)), txt(JSON.stringify(outcome, null, 2))], isError: failed };
    },
  );

  // ---- IntelliSense health: does clangd understand the project's own files? ----
  server.registerTool(
    "o3de_intellisense_health",
    {
      title: "O3DE IntelliSense Health Check",
      description:
        "Check whether clangd actually understands this project's C++ files, on this machine: the same check as the " +
        "command O3DE: Check IntelliSense Health. It samples files from the compile database clangd reads (O3DE's generated " +
        "one, or the user's own; whichever clangd.arguments names) - spread over the project, gem, engine Framework, engine " +
        "gem and fallback entries, the same files every time - plus up to " + MAX_ENTRYLESS + " sources the database has NO entry " +
        "for (includeEntryless), and runs `clangd --check` on each (two at a time, 60 s per file). Read-only: it builds " +
        "no index and writes nothing. Returns report.summary and report.findings (plain sentences: what is wrong, what to do), " +
        "the extension and clangd versions, report.clangd (binary, version, where it was found), report.toolchain " +
        "(compiler and msvc/gnu switch style), report.database (file, whose it is, entries by origin, whether clangd.arguments " +
        "points at it, and how many include directories the entries name that do not exist on disk), report.engine " +
        "(native / redirected / headersOnly, with a hint to attach a source engine for headersOnly) and report.files: per " +
        "sampled file its origin (or noEntry), errors (real compile errors only, never clangd's refactoring-tweak noise), the " +
        "first error lines, and whether clangd used the file's own entry or inferred flags from another file (command, " +
        "inferredFrom). A clean sample with entries means IntelliSense works; errors on files with an entry mean a missing " +
        "include path or define; files with command:inferred have no entry at all. Takes up to ~5 minutes with a client that " +
        "sends a progress token (progress is streamed); a client without one gets a partial result after ~45 s " +
        "(report.partial lists the files skipped) - ask for a smaller sampleSize then. With no O3DE project open it refuses at " +
        "once (isError, reason noProject). clangd not found or no database is not an error: it is reported in report.findings.",
      inputSchema: {
        sampleSize: z
          .number()
          .int()
          .min(MIN_SAMPLE_SIZE)
          .max(MAX_SAMPLE_SIZE)
          .optional()
          .describe(`How many files from the database to check, ${MIN_SAMPLE_SIZE}-${MAX_SAMPLE_SIZE} (default ${DEFAULT_SAMPLE_SIZE}).`),
        includeEntryless: z
          .boolean()
          .optional()
          .describe(`Also check up to ${MAX_ENTRYLESS} sources the database has no entry for (default true).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args: { sampleSize?: number; includeEntryless?: boolean }, extra) => runIntellisenseHealthTool(args, extra, opts),
  );

  return server;
}

// ---- The health tool's handler ---------------------------------------------
/** What the health tool reads from the server's options. */
type HealthToolOptions = Pick<McpHttpOptions, "buildOptions" | "version" | "globalStorageRoot">;

/**
 * The body of o3de_intellisense_health. A client with a progress token is kept alive by heartbeats for the full budget
 * (TOTAL_BUDGET_MS); one without cannot be held long, so its check gets INLINE_BUDGET_MS. An unexpected failure of the
 * check comes back as an isError result carrying its message, never as a rejected call. Exported for the progress test,
 * which injects `start` and shortens the heartbeat.
 */
export async function runIntellisenseHealthTool(
  args: { sampleSize?: number; includeEntryless?: boolean },
  extra: CallExtra,
  opts: HealthToolOptions,
  start: typeof startHealthCheck = startHealthCheck,
  heartbeatMs = HEARTBEAT_MS,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const canStream = extra?._meta?.progressToken !== undefined;
  try {
    const run = start(
      opts.buildOptions,
      { extensionVersion: opts.version, globalStorageRoot: opts.globalStorageRoot },
      {
        sampleSize: args.sampleSize,
        includeEntryless: args.includeEntryless,
        maxTotalMs: canStream ? TOTAL_BUDGET_MS : INLINE_BUDGET_MS,
        signal: extra?.signal,
      },
    );
    await holdUntilDone(
      extra,
      run,
      (elapsed) => `Checking IntelliSense health... ${run.progress.checked} of ${run.progress.total} files checked, ${elapsed}s elapsed`,
      undefined,
      heartbeatMs,
    );
    const outcome = await run.done; // without a progress token holdUntilDone returns early: the budget above bounds this wait
    if (!outcome.ok) {
      return { content: [txt(outcome.message), txt(JSON.stringify(outcome, null, 2))], isError: true };
    }
    return { content: [txt(healthSummaryLine(outcome.report)), txt(JSON.stringify(outcome, null, 2))] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log().warn(`o3de_intellisense_health failed: ${message}`);
    return { content: [txt(`The IntelliSense health check failed: ${message}`)], isError: true };
  }
}

type CallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A background job an MCP call can wait on (build and configure jobs both fit). */
interface WaitableJob {
  startedAt: number;
  result?: unknown; // set when finished
  done: Promise<unknown>;
}

/** The progress count of ONE tool call. Every phase of the call shares it: MCP progress must increase across the call. */
interface ProgressCounter {
  step: number;
}

/**
 * Hold a tool call open until the job finishes. With a client progress token, up to MAX_BLOCK_MS, sending a progress
 * heartbeat every `heartbeatMs` (resets the client's timeout, keeps proxies from idling out the stream). Without one,
 * only INLINE_WAIT_MS — the caller then hands back an id to poll. Returns as soon as the job finishes. Exported for
 * the progress test, which shortens the heartbeat.
 */
export async function holdUntilDone(
  extra: CallExtra,
  job: WaitableJob,
  progressMessage: (elapsedSeconds: number) => string,
  progress: ProgressCounter = { step: 0 },
  heartbeatMs = HEARTBEAT_MS,
): Promise<void> {
  const progressToken = extra?._meta?.progressToken;
  const maxWaitMs = progressToken !== undefined ? MAX_BLOCK_MS : INLINE_WAIT_MS;
  const isDone = (): boolean => job.result !== undefined;
  const started = Date.now();
  while (!isDone() && Date.now() - started < maxWaitMs && !extra?.signal?.aborted) {
    await Promise.race([delay(progressToken !== undefined ? heartbeatMs : 500), job.done]);
    if (progressToken !== undefined && !isDone()) {
      progress.step += 1;
      await sendProgress(extra, progress.step, progressMessage(Math.round((Date.now() - job.startedAt) / 1000)));
    }
  }
}

/** Send one progress notification if the client gave a progress token (otherwise nothing). */
async function sendProgress(extra: CallExtra, step: number, message: string): Promise<void> {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) {
    return;
  }
  await extra
    .sendNotification({ method: "notifications/progress", params: { progressToken, progress: step, message } })
    .catch(() => undefined); // client not listening — ignore
}

/**
 * o3de_build waitForEditorExit: wait for the Editor/ScriptCanvas to close before the build job starts. Returns
 * undefined when it is clear (build now), or the reason to refuse instead (timed out, cancelled, or out of time
 * without a progress token). A client with a progress token gets a heartbeat every `heartbeatMs` and the full
 * maxWaitMinutes; one without gets only INLINE_WAIT_MS, like holdUntilDone. Exported for the progress test, which
 * injects the process probe and shortens the heartbeat.
 */
export async function waitForEditorExit(
  extra: CallExtra,
  maxWaitMinutes: number,
  progress: ProgressCounter,
  probe: () => Promise<string[]> = runningGuardedProcesses,
  heartbeatMs = HEARTBEAT_MS,
): Promise<string | undefined> {
  const canStream = extra?._meta?.progressToken !== undefined;
  const outcome = await waitForProcessesToExit({
    probe,
    pollMs: heartbeatMs,
    maxWaitMs: canStream ? maxWaitMinutes * 60_000 : INLINE_WAIT_MS,
    signal: extra?.signal,
    onWaiting: (running, elapsedMs) => {
      if (running.length > 0) {
        progress.step += 1;
        void sendProgress(extra, progress.step, describeWait(running, elapsedMs));
      }
    },
  });

  const what = outcome.running.join(" and ") || "the Editor";
  if (outcome.status === "cancelled") {
    return `Stopped waiting for ${what} to close — no build was started.`;
  }
  if (outcome.status === "timeout") {
    return canStream
      ? `Gave up after ${maxWaitMinutes} min waiting for ${what} to close.`
      : `${what} is still running after ${Math.round(outcome.waitedMs / 1000)}s. This client sent no progress token, ` +
          `so the call cannot wait longer; a progress-capable client can wait up to ${maxWaitMinutes} min ` +
          `(maxWaitMinutes). Ask the user to close it, then call o3de_build again.`;
  }
  return undefined;
}

/** The blocked:editor-running result for a build that was never started (no cmake, no job, nothing persisted). */
function editorRunningResult(config: string, targets: string[], summary: string): BuildResult {
  return {
    ok: false,
    exitCode: null,
    durationMs: 0,
    command: "",
    targets,
    config,
    errors: [],
    warnings: [],
    summary,
    rawTail: "",
    blocked: "editor-running",
  };
}

/** Shape a finished ConfigureResult into the tool response (summary line + full JSON). */
function configureResultContent(result: ConfigureResult): { content: { type: "text"; text: string }[]; isError: boolean } {
  const headline = result.blocked ? `${result.summary} (blocked: ${result.blocked})` : result.summary;
  return {
    content: [txt(headline), txt(JSON.stringify(result, null, 2))],
    isError: result.blocked !== undefined, // a configure that ran and failed is a valid result (errors listed)
  };
}

/** The one-line summary of an o3de_read_run_log call. */
function runLogSummary(report: RunLogReport): string {
  const tail = report.log;
  if (!tail) {
    return report.note ?? "No log to read.";
  }
  const name = basename(tail.path);
  if (tail.readError) {
    return `Could not read ${name}: ${tail.readError}`;
  }
  if (!tail.exists) {
    return `${name} not found for ${report.project?.name} — has the app run yet?`;
  }
  return `${name}: last ${tail.lines} lines, written ${tail.ageSeconds}s ago${tail.truncated ? " (truncated)" : ""}.`;
}

/** A text content block (keeps the tool handlers terse). */
function txt(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** "394 project, 100 gem, 1265 engine Framework, 165 engine gem, 12 fallback" — the entries by origin. */
function originsLine(origins: OriginCounts): string {
  return (
    `${origins.project} project, ${origins.gem} gem, ${origins.engineFramework} engine Framework, ` +
    `${origins.engineGems} engine gem, ${origins.fallback} fallback`
  );
}

/** What is worth saying about which compile database is selected, as a sentence ("" for the plain default: O3DE generates it). */
function compileDatabaseNote(selection: DatabaseSelection | undefined): string {
  if (!selection) {
    return "";
  }
  if (selection.source === "user") {
    return `Using your own compile database, ${selection.file} (O3DE never writes it).`;
  }
  if (selection.missing) {
    return `o3de.intellisense.compileDatabase "${selection.setting}" was not found, so the database is generated.`;
  }
  return selection.hint ? `A compile_commands.json exists at ${selection.hint} but isn't used: set o3de.intellisense.compileDatabase to use it.` : "";
}

/** The note as one more segment of the status line ("" when there is nothing to say). */
function compileDatabaseLine(selection: DatabaseSelection | undefined): string {
  const note = compileDatabaseNote(selection);
  return note ? `${note} · ` : "";
}

/** Shape a finished BuildResult into the tool response (summary line + full JSON). */
function buildResultContent(result: BuildResult): { content: { type: "text"; text: string }[]; isError: boolean } {
  const headline = result.blocked ? `${result.summary} (blocked: ${result.blocked})` : result.summary;
  return {
    content: [
      { type: "text", text: headline },
      { type: "text", text: JSON.stringify(result, null, 2) },
    ],
    // A build that ran and failed is a valid result (errors listed); only a
    // couldn't-run "blocked" state is surfaced as a tool error.
    isError: result.blocked !== undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Small http helpers ----------------------------------------------------
function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}
