// ============================================================================
//  lsp.mjs - a minimal Language Server Protocol client over stdio
//
//  Just enough for the benchmark: requests with timeouts, notifications, waiting
//  for one specific notification, answering the server's own requests, and a
//  clean shutdown. Messages are framed as
//
//      Content-Length: <BYTES>\r\n\r\n<UTF-8 JSON body>
//
//  The length is in BYTES, not characters, so non-ASCII text frames correctly.
// ============================================================================

import { spawnTracked } from "./procs.mjs";

// ============================================================================
//  FRAMING
// ============================================================================

/**
 * Encode one JSON-RPC message as an LSP frame.
 * @param {object} message
 * @returns {Buffer}
 */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/** Incremental decoder: push raw chunks in, get complete messages out. */
export class FrameParser {
  constructor() {
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {any[]} every message completed by this chunk
   */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`LSP frame without Content-Length: ${JSON.stringify(header)}`);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (this.buffer.length < bodyEnd) break; // body not complete yet
      messages.push(JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
      this.buffer = this.buffer.subarray(bodyEnd);
    }
    return messages;
  }
}

// ============================================================================
//  CLIENT
// ============================================================================

export class LspClient {
  /**
   * @param {import("node:child_process").ChildProcess} child  a server with piped stdio
   */
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string}>} */
    this.pending = new Map();
    /** @type {Map<string, Function[]>} */
    this.notificationHandlers = new Map();
    /** @type {Map<string, Function>} */
    this.requestHandlers = new Map();
    /** @type {{resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string, test: Function}[]} */
    this.waiters = [];
    this.parser = new FrameParser();
    this.exited = false;
    this.exitCode = /** @type {number | null} */ (null);
    /** @type {Function[]} */
    this.exitListeners = [];
    this.stderrTail = "";

    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.stdin.on("error", () => {}); // a dead server surfaces through "exit"
    child.once("exit", (code) => this.onExit(code));
    child.once("error", (err) => this.onExit(null, err));
  }

  /**
   * Start a server process and wrap it.
   * @param {string} command
   * @param {string[]} args
   * @param {import("node:child_process").SpawnOptions} [options]
   * @returns {LspClient}
   */
  static spawn(command, args, options = {}) {
    return new LspClient(spawnTracked(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
  }

  // ----------------------------------------------------------------------
  //  Sending
  // ----------------------------------------------------------------------

  /**
   * Send a request and wait for its response.
   * @param {string} method
   * @param {any} params
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs = 30000) {
    if (this.exited) return Promise.reject(new Error(`${method}: server already exited`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * @param {string} method
   * @param {any} [params]
   */
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** @param {object} message */
  send(message) {
    if (this.exited) return;
    this.child.stdin.write(encodeMessage(message));
  }

  // ----------------------------------------------------------------------
  //  Receiving
  // ----------------------------------------------------------------------

  /**
   * Call `handler(params)` for every notification named `method`.
   * @param {string} method
   * @param {(params: any) => void} handler
   */
  onNotification(method, handler) {
    if (!this.notificationHandlers.has(method)) this.notificationHandlers.set(method, []);
    this.notificationHandlers.get(method).push(handler);
  }

  /**
   * Answer the server's own requests named `method`. The return value is the result.
   * Requests with no handler are answered with null.
   * @param {string} method
   * @param {(params: any) => any} handler
   */
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Resolve with the params of the next notification named `method` that passes `test`.
   * Call this BEFORE sending whatever provokes the notification, then await it later.
   * @param {string} method
   * @param {(params: any) => boolean} test
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  waitForNotification(method, test, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        test,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`${method}: not received within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** @param {Buffer} chunk */
  onData(chunk) {
    let messages;
    try {
      messages = this.parser.push(chunk);
    } catch (err) {
      this.failAll(err);
      this.child.kill();
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  /** @param {any} message */
  dispatch(message) {
    const hasId = message.id !== undefined && message.id !== null;

    if (hasId && message.method) {
      // a request from the server
      const handler = this.requestHandlers.get(message.method);
      let result = null;
      try {
        if (handler) result = handler(message.params) ?? null;
      } catch {
        result = null;
      }
      this.send({ jsonrpc: "2.0", id: message.id, result });
    } else if (hasId) {
      // a response to one of ours
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        // rpcError marks "the server answered with an error", as opposed to a timeout or a dead server
        entry.reject(Object.assign(new Error(`${entry.method}: ${message.error.message ?? JSON.stringify(message.error)}`), { rpcError: message.error }));
      } else {
        entry.resolve(message.result);
      }
    } else if (message.method) {
      // a notification
      for (const handler of this.notificationHandlers.get(message.method) ?? []) handler(message.params);
      for (const waiter of [...this.waiters]) {
        if (waiter.method === message.method && waiter.test(message.params)) {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
        }
      }
    }
  }

  // ----------------------------------------------------------------------
  //  Ending
  // ----------------------------------------------------------------------

  /**
   * @param {number | null} code
   * @param {Error} [error]
   */
  onExit(code, error) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.failAll(error ?? new Error(`server exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));
    this.exitListeners.forEach((fn) => fn());
  }

  /** @param {Error} error */
  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  /**
   * LSP shutdown + exit; kills the server if it does not leave within `graceMs`.
   * @param {number} [graceMs]
   * @returns {Promise<void>}
   */
  async shutdown(graceMs = 8000) {
    if (!this.exited) {
      try {
        await this.request("shutdown", null, graceMs);
        this.notify("exit");
      } catch {
        // fall through to the kill below
      }
    }
    await this.waitForExit(graceMs);
    this.kill();
    await this.waitForExit(3000);
  }

  /**
   * Resolve when the server has exited, or after `timeoutMs`.
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  waitForExit(timeoutMs) {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.exitListeners.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Kill the server now (no-op when it has already exited). */
  kill() {
    if (!this.exited) this.child.kill();
  }
}
