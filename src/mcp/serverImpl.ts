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
//  Tools: health (o3de_ping), build (o3de_build + _status/_log), run
//  (o3de_is_running, o3de_run), and config (o3de_get/set_config, o3de_list_targets).
// ============================================================================

import * as http from "http";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { log } from "../log";
import { BuildOptions, BuildConfig, RunTarget } from "../build/buildOptions";
import { startBuildJob, getBuildJob } from "../build/buildJobs";
import { BuildResult } from "../build/buildOutput";
import { configSnapshot, applyConfig, listTargets } from "../build/configQuery";
import { runStatus, launchRunTarget, forceCloseRuntime } from "../build/runQuery";

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

export interface McpHttpOptions {
  port: number;
  token: string;
  requireToken: boolean; // when false, the localhost bind is the only gate (no 401 → no OAuth cascade)
  allowForceClose: boolean; // expose the destructive o3de_force_close tool (opt-in)
  version: string;
  buildOptions: BuildOptions;
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
      },
    },
    async (args: { targets?: string[]; config?: BuildConfig }, extra) => {
      const config = args.config ?? opts.buildOptions.config;
      const targets = args.targets ?? opts.buildOptions.targets;
      const job = startBuildJob({ generator: opts.buildOptions.generator, config, targets, coreCount: opts.buildOptions.coreCount });

      // Block until done, streaming progress heartbeats if the client gave us a
      // token (keeps the SSE connection alive + resets the client timeout). With a
      // token we hold up to MAX_BLOCK_MS; without one, only a short safe window.
      const progressToken = extra?._meta?.progressToken;
      const maxWaitMs = progressToken !== undefined ? MAX_BLOCK_MS : INLINE_WAIT_MS;
      const started = Date.now();
      let step = 0;
      while (!job.result && Date.now() - started < maxWaitMs && !extra?.signal?.aborted) {
        await delay(progressToken !== undefined ? HEARTBEAT_MS : 500);
        if (progressToken !== undefined && !job.result) {
          step += 1;
          const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
          await extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: step, message: `Building ${config}… ${elapsed}s elapsed` },
            })
            .catch(() => undefined); // client not listening — ignore
        }
      }

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

  // ---- Run: is-running probe + launch (no force-close) ---------------------
  server.registerTool(
    "o3de_is_running",
    {
      title: "O3DE Is Running",
      description:
        "Check whether the O3DE Editor or GameLauncher is currently running for the workspace project — WITHOUT " +
        "building. A running Editor locks the gem DLLs, so o3de_build fails the link with blocked:editor-running; " +
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
        "Returns IMMEDIATELY once launched (it does not block); use o3de_is_running to confirm it is up. The exe " +
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
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args: { target?: RunTarget; config?: BuildConfig }) => {
      const result = launchRunTarget(opts.buildOptions, { target: args.target, config: args.config });
      const line = result.launched
        ? `Launched ${result.target} (${result.config}, pid ${result.pid}).`
        : result.alreadyRunning
          ? `${result.target} already running — left alone.`
          : `Did not launch: ${result.reason}`;
      return {
        content: [txt(line), txt(JSON.stringify(result, null, 2))],
        // alreadyRunning is a valid, non-error outcome; only a genuine failure is an error.
        isError: !result.launched && !result.alreadyRunning,
      };
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
        "launch args — plus the valid choices for each and the resolved project + build directory. Use this before " +
        "o3de_set_config or o3de_build to see the current state and what's allowed.",
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
        "Only the fields you pass change; others are left alone. Returns the updated config. Note: changing the " +
        "generator usually requires re-running “O3DE: Configure Project” before the next build.",
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
        launchArgs: z.string().optional().describe("Extra args passed when running (blank to clear)."),
      },
    },
    async (args) => {
      const applied = await applyConfig(opts.buildOptions, args);
      const snap = configSnapshot(opts.buildOptions);
      const line = applied.length ? `Updated: ${applied.join(", ")}.` : "No changes — no fields provided.";
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

  return server;
}

/** A text content block (keeps the tool handlers terse). */
function txt(text: string): { type: "text"; text: string } {
  return { type: "text", text };
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
