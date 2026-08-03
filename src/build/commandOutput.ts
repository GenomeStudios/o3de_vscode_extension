// ============================================================================
//  Command output channel — the raw stream from managed external commands.
//
//  Deliberately separate from log.ts. log() is a LogOutputChannel: every write
//  is stamped with a timestamp + level and the panel filters by level. That is
//  right for the extension's own reporting and WRONG for raw cmake / ninja /
//  python output, which has to appear verbatim to be readable.
//
//  So: child-process bytes land here (plain channel, no decoration), and the
//  extension's narration stays in log() with a one-line pointer across
//  ("Build started - see O3DE Build Output"). Mirrors log.ts's lazy + fallback
//  shape so modules exercised directly by unit tests don't crash on it.
// ============================================================================

import * as vscode from "vscode";

const CHANNEL_NAME = "O3DE Build Output";

let channel: vscode.OutputChannel | undefined;

// ---- Lifecycle -------------------------------------------------------------
/** Create the channel. Call once from activate(); disposed with the extension. */
export function initCommandOutput(context: vscode.ExtensionContext): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(channel);
  return channel;
}

// A console-backed fallback so code paths that can run before activate() (e.g.
// unit tests exercising the runner directly) don't crash on commandOutput().
const fallback = {
  name: CHANNEL_NAME,
  append: (value: string) => process.stdout.write(value),
  appendLine: (value: string) => console.log(value),
  replace: () => undefined,
  clear: () => undefined,
  show: () => undefined,
  hide: () => undefined,
  dispose: () => undefined,
} as unknown as vscode.OutputChannel;

// ---- Access ----------------------------------------------------------------
/** The shared raw-output channel. Falls back to console before initCommandOutput(). */
export function commandOutput(): vscode.OutputChannel {
  return channel ?? fallback;
}
