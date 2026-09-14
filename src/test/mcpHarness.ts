// ============================================================================
//  MCP test harness — the extension's real localhost MCP server on a free port,
//  connected the way Claude Code connects (Streamable HTTP, MCP SDK client).
//  Shared by the end-to-end MCP suites. The vscode-test host has no workspace
//  folder and neither the C/C++ extension nor clangd installed.
// ============================================================================

import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BuildOptions } from "../build/buildOptions";
import { McpHttpHandle, startMcpHttpServer } from "../mcp/serverImpl";

type TextContent = { type: string; text: string };

export interface McpHarness {
  client: Client;
  state: vscode.Memento;
  buildOptions: BuildOptions;
  close(): Promise<void>;
}

/** An in-memory Memento (workspaceState stand-in). */
export function memoryMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string, defaultValue?: unknown) => (values.has(key) ? values.get(key) : defaultValue),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
}

/** Start the server and connect a client. */
export async function startMcpHarness(): Promise<McpHarness> {
  const state = memoryMemento();
  const buildOptions = new BuildOptions(state);
  const handle: McpHttpHandle = await startMcpHttpServer({
    port: 0, // any free port
    token: "test",
    requireToken: false,
    allowForceClose: false,
    version: "test",
    buildOptions,
    workspaceState: state,
  });
  const client = new Client({ name: "o3de-tests", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)));
  return {
    client,
    state,
    buildOptions,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

/** A tool's summary line (every O3DE tool returns it first). */
export function summaryLine(result: unknown): string {
  return (result as { content: TextContent[] }).content[0].text;
}

/** A tool's JSON payload (the second content block, when present). */
export function payload<T>(result: unknown): T {
  return JSON.parse((result as { content: TextContent[] }).content[1].text) as T;
}
