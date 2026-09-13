// ============================================================================
//  O3DE MCP server — the public lifecycle handle (SDK-free).
//
//  Wraps the localhost MCP endpoint an LLM (e.g. Claude) connects to. This file
//  imports NONE of the MCP SDK directly: start() does an `await import()` of
//  serverImpl.ts, so the SDK is only loaded/evaluated when the user opts into
//  LLM connections. Off by default → zero cost at activation.
//
//  Security: binds 127.0.0.1 only and mints a per-machine bearer token (kept in
//  globalState). Show the client config via the "Show LLM Connection Info" command.
// ============================================================================

import * as vscode from "vscode";
import * as crypto from "crypto";
import { log } from "../log";
import { BuildOptions } from "../build/buildOptions";
import { readProject } from "../o3de/identity";
import { writeMcpServerEntry, removeMcpServerEntry, mcpConfigPath, hasMcpServerEntry, SERVER_NAME } from "./mcpConfig";
import type { McpHttpHandle } from "./serverImpl";

const TOKEN_KEY = "o3de.llm.token";
const DEFAULT_PORT = 8975;

// The port the endpoint is actually bound to right now (undefined when stopped).
// Published so the Onboarding row can show the TRUE port, not the raw setting.
let livePort: number | undefined;

/** The live endpoint port, or undefined when the endpoint isn't running. */
export function liveEndpointPort(): number | undefined {
  return livePort;
}

//  The TRUE functional state — not just the setting. "on" only when the server is
//  actually listening AND the project's .mcp.json has our entry (i.e. a client
//  could really connect). Anything short of that is "incomplete", so onboarding
//  stops claiming it works when it doesn't.
export type LlmConnectionState = "off" | "incomplete" | "on";

export function llmConnectionStatus(): { state: LlmConnectionState; port?: number; hasConfig: boolean } {
  const root = projectRoot();
  // llm.enabled is per-project (folder-scoped) -> read it against the project root.
  const enabled = vscode.workspace
    .getConfiguration("o3de", root ? vscode.Uri.file(root) : undefined)
    .get<boolean>("llm.enabled", false);
  if (!enabled) {
    return { state: "off", hasConfig: false };
  }
  const hasConfig = root ? hasMcpServerEntry(root) : false;
  if (livePort !== undefined && hasConfig) {
    return { state: "on", port: livePort, hasConfig };
  }
  return { state: "incomplete", port: livePort, hasConfig };
}

export class O3deMcpServer {
  private handle: McpHttpHandle | undefined;
  private busy = false; // guards overlapping start/stop transitions

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly buildOptions: BuildOptions,
  ) {}

  get isRunning(): boolean {
    return this.handle !== undefined;
  }

  get port(): number | undefined {
    return this.handle?.port;
  }

  /** The per-machine bearer token, minted once and persisted. */
  get token(): string {
    let token = this.context.globalState.get<string>(TOKEN_KEY);
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      void this.context.globalState.update(TOKEN_KEY, token);
    }
    return token;
  }

  // ---- Lifecycle -----------------------------------------------------------
  /** Start the endpoint (no-op if already running). Lazy-loads the MCP SDK. */
  async start(): Promise<void> {
    if (this.handle || this.busy) {
      return;
    }
    this.busy = true;
    try {
      const port = configuredPort();
      const version = (this.context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
      const { startMcpHttpServer } = await import("./serverImpl.js");
      this.handle = await startMcpHttpServer({
        port,
        token: this.token,
        requireToken: requireToken(),
        allowForceClose: allowForceClose(),
        version,
        buildOptions: this.buildOptions,
        workspaceState: this.context.workspaceState,
      });
      livePort = this.handle.port; // publish the actual bound port (for the Optional row / status)
      this.writeClientConfig(); // keep the project's .mcp.json in sync with the live port
    } catch (err) {
      log().error(`Failed to start the LLM (MCP) endpoint: ${message(err)}`);
      void vscode.window.showErrorMessage(`O3DE: could not start the LLM connection endpoint — ${message(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Stop the endpoint (no-op if not running). */
  async stop(): Promise<void> {
    const handle = this.handle;
    if (!handle) {
      return;
    }
    this.handle = undefined;
    livePort = undefined;
    try {
      await handle.close();
      log().info("LLM (MCP) endpoint stopped.");
    } catch (err) {
      log().warn(`Error stopping the LLM (MCP) endpoint: ${message(err)}`);
    }
  }

  /** Stop then start — used to pick up a changed port while enabled. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** The connection details a client (Claude Code `.mcp.json`) needs. */
  connectionInfo(): { url: string; token: string; mcpJson: string } {
    const entry = this.serverEntry();
    return { url: entry.url, token: this.token, mcpJson: JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2) };
  }

  /** Auto-merge our entry into the project's .mcp.json (setting-gated). */
  writeClientConfig(): void {
    if (!writeConfigEnabled()) {
      return;
    }
    const root = projectRoot();
    if (!root) {
      log().info(
        "LLM (MCP): no project folder open, so .mcp.json was not written. Open your O3DE project folder, " +
          "or run “O3DE: Show LLM Connection Info” → “Write .mcp.json” to choose a location.",
      );
      return;
    }
    writeMcpServerEntry(root, this.serverEntry());
  }

  /** Write .mcp.json for the user, prompting for a folder when there's no project root. */
  async writeClientConfigInteractive(): Promise<void> {
    let root = projectRoot();
    if (!root) {
      const pick = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: "No project folder open — pick the folder where you run Claude (its .mcp.json)",
        openLabel: "Write .mcp.json here",
      });
      root = pick?.[0]?.fsPath;
    }
    if (!root) {
      return;
    }
    writeMcpServerEntry(root, this.serverEntry());
    const choice = await vscode.window.showInformationMessage(`O3DE: wrote .mcp.json → ${root}`, "Open .mcp.json");
    if (choice === "Open .mcp.json") {
      await vscode.window.showTextDocument(vscode.Uri.file(mcpConfigPath(root)));
    }
  }

  /** Remove our entry from the project's .mcp.json (on disable). */
  removeClientConfig(): void {
    const root = projectRoot();
    if (root) {
      removeMcpServerEntry(root);
    }
  }

  /** The `.mcp.json` server entry for the live endpoint (url + optional bearer). */
  private serverEntry(): { type: "http"; url: string; headers?: { Authorization: string } } {
    const port = this.handle?.port ?? configuredPort();
    const url = `http://127.0.0.1:${port}/mcp`;
    // Only advertise the bearer header when token auth is on — otherwise the
    // endpoint is open on localhost and a header would just confuse the client.
    return requireToken() ? { type: "http", url, headers: { Authorization: `Bearer ${this.token}` } } : { type: "http", url };
  }

  dispose(): void {
    void this.stop();
  }
}

// ---- Helpers ---------------------------------------------------------------
//  Port resolution supports multiple VS Code windows (one per O3DE project):
//  each window binds its OWN stable port so they never collide, and each
//  project's pasted .mcp.json stays valid across reloads. `o3de.llm.port` = 0
//  (default) derives a deterministic per-project port; a non-zero value pins it.
function configuredPort(): number {
  const explicit = vscode.workspace.getConfiguration("o3de").get<number>("llm.port", 0);
  return explicit && explicit > 0 ? explicit : derivePerProjectPort();
}

/** A stable port in [BASE, BASE+SPAN) derived from the project identity (FNV-1a). */
function derivePerProjectPort(): number {
  const SPAN = 200;
  const id = projectIdentity();
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return DEFAULT_PORT + (Math.abs(h) % SPAN);
}

/** The identity that distinguishes this window's endpoint — its O3DE project path. */
function projectIdentity(): string {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (readProject(folder.uri.fsPath)) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "o3de-default";
}

function requireToken(): boolean {
  return vscode.workspace.getConfiguration("o3de").get<boolean>("llm.requireToken", false);
}

// Whether the destructive o3de_force_close tool is exposed at all. OFF by default:
// the assistant cannot close a running Editor unless the user opts in, and even
// then the tool is marked destructive so the client asks before every call.
function allowForceClose(): boolean {
  // Folder-scoped -> read against the project root so a value in the project's
  // .vscode/settings.json is honored (not just the workspace-level value).
  const root = projectRoot();
  return vscode.workspace
    .getConfiguration("o3de", root ? vscode.Uri.file(root) : undefined)
    .get<boolean>("llm.allowForceClose", false);
}

function writeConfigEnabled(): boolean {
  return vscode.workspace.getConfiguration("o3de").get<boolean>("llm.writeMcpConfig", true);
}

/** The project folder to write .mcp.json into (the O3DE project, else the first folder). */
function projectRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (readProject(folder.uri.fsPath)) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function message(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}
