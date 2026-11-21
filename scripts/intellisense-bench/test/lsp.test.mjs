import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameParser, LspClient, encodeMessage } from "../lib/lsp.mjs";

// ============================================================================
//  framing
// ============================================================================

test("encodeMessage: Content-Length counts BYTES, not characters", () => {
  const message = { jsonrpc: "2.0", method: "x", params: { text: "héllo 日本語 😀" } };
  const frame = encodeMessage(message);
  const separator = frame.indexOf("\r\n\r\n");
  const header = frame.subarray(0, separator).toString("ascii");
  const body = frame.subarray(separator + 4);

  const declared = Number(/Content-Length: (\d+)/.exec(header)[1]);
  assert.equal(declared, body.length);
  assert.equal(declared, Buffer.byteLength(JSON.stringify(message), "utf8"));
  assert.ok(declared > JSON.stringify(message).length, "non-ASCII text must make bytes > characters");
});

test("FrameParser: several messages in one chunk", () => {
  const parser = new FrameParser();
  const chunk = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 }), encodeMessage({ id: 3 })]);
  assert.deepEqual(parser.push(chunk), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("FrameParser: a frame split at EVERY byte offset (including inside a UTF-8 sequence) still decodes", () => {
  const message = { text: "日本語 😀 é" };
  const frame = encodeMessage(message);
  for (let cut = 1; cut < frame.length; cut++) {
    const parser = new FrameParser();
    const first = parser.push(frame.subarray(0, cut));
    const second = parser.push(frame.subarray(cut));
    assert.deepEqual([...first, ...second], [message], `split at byte ${cut}`);
  }
});

test("FrameParser: byte-by-byte delivery", () => {
  const parser = new FrameParser();
  const frame = encodeMessage({ text: "éé" });
  const out = [];
  for (const byte of frame) out.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(out, [{ text: "éé" }]);
});

test("FrameParser: extra headers are ignored, a missing Content-Length is an error", () => {
  const body = Buffer.from('{"ok":true}');
  const withType = Buffer.concat([Buffer.from(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`), body]);
  assert.deepEqual(new FrameParser().push(withType), [{ ok: true }]);
  assert.throws(() => new FrameParser().push(Buffer.from("X-Nothing: 1\r\n\r\n{}")), /Content-Length/);
});

// ============================================================================
//  client against a fake server process
// ============================================================================

/** Runs inside a child node process (see startFake): a tiny LSP server. */
function fakeServer() {
  let buffer = Buffer.alloc(0);
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  const handle = (m) => {
    if (m.method === "echo") send({ jsonrpc: "2.0", id: m.id, result: { text: m.params.text, bytes: Buffer.byteLength(m.params.text, "utf8") } });
    else if (m.method === "greet") {
      send({ jsonrpc: "2.0", method: "server/hello", params: { n: 1 } });
      send({ jsonrpc: "2.0", id: m.id, result: "ok" });
    } else if (m.method === "ask-client") {
      send({ jsonrpc: "2.0", id: 900, method: "client/question", params: { q: 1 } });
      send({ jsonrpc: "2.0", id: m.id, result: "asked" });
    } else if (m.id === 900 && !m.method) send({ jsonrpc: "2.0", method: "server/answerSeen", params: { result: m.result } });
    else if (m.method === "fail") send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "boom" } });
    else if (m.method === "die") process.exit(3);
    else if (m.method === "shutdown") send({ jsonrpc: "2.0", id: m.id, result: null });
    else if (m.method === "exit") process.exit(0);
    // "silent" and anything else: no answer
  };
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      handle(message);
    }
  });
}

function startFake() {
  return LspClient.spawn(process.execPath, ["-e", `(${fakeServer.toString()})()`]);
}

test("client: request/response with non-ASCII text crosses the pipe intact", async () => {
  const client = startFake();
  try {
    const text = "héllo 日本語 😀";
    const result = await client.request("echo", { text }, 10000);
    assert.equal(result.text, text);
    assert.equal(result.bytes, Buffer.byteLength(text, "utf8")); // the server decoded exactly the bytes we framed
  } finally {
    await client.shutdown();
  }
});

test("client: notification handlers and waitForNotification see server notifications", async () => {
  const client = startFake();
  try {
    const seen = [];
    client.onNotification("server/hello", (params) => seen.push(params.n));
    const waiter = client.waitForNotification("server/hello", (params) => params.n === 1, 5000); // registered BEFORE the trigger
    assert.equal(await client.request("greet", {}, 5000), "ok");
    assert.deepEqual(await waiter, { n: 1 });
    assert.deepEqual(seen, [1]);
  } finally {
    await client.shutdown();
  }
});

test("client: the server's own requests are answered by onRequest handlers", async () => {
  const client = startFake();
  try {
    client.onRequest("client/question", (params) => ({ answer: params.q + 41 }));
    const waiter = client.waitForNotification("server/answerSeen", () => true, 5000);
    await client.request("ask-client", {}, 5000);
    assert.deepEqual((await waiter).result, { answer: 42 });
  } finally {
    await client.shutdown();
  }
});

test("client: an error response rejects with the server's message", async () => {
  const client = startFake();
  try {
    await assert.rejects(client.request("fail", {}, 5000), /fail: boom/);
  } finally {
    await client.shutdown();
  }
});

test("client: an error reply carries rpcError; a timeout does not (a probe tells 'clangd said no' from 'no answer')", async () => {
  const client = startFake();
  try {
    const refused = await client.request("fail", {}, 5000).catch((err) => err);
    assert.deepEqual(refused.rpcError, { code: -32000, message: "boom" });
    const timedOut = await client.request("silent", {}, 100).catch((err) => err);
    assert.equal(timedOut.rpcError, undefined);
    assert.match(timedOut.message, /no response within/);
  } finally {
    await client.shutdown();
  }
});

test("client: a request with no answer times out", async () => {
  const client = startFake();
  try {
    await assert.rejects(client.request("silent", {}, 150), /no response within 150 ms/);
    await assert.rejects(client.waitForNotification("never", () => true, 100), /not received within 100 ms/);
  } finally {
    await client.shutdown();
  }
});

test("client: a crashed server rejects pending requests and is marked exited", async () => {
  const client = startFake();
  const pending = client.request("silent", {}, 10000);
  client.notify("die");
  await assert.rejects(pending, /server exited/);
  assert.equal(client.exited, true);
  assert.equal(client.exitCode, 3);
  await assert.rejects(client.request("echo", { text: "x" }), /already exited/);
});

test("client: shutdown() ends the server; kill() is safe afterwards", async () => {
  const client = startFake();
  await client.request("echo", { text: "x" }, 5000);
  await client.shutdown();
  assert.equal(client.exited, true);
  assert.equal(client.exitCode, 0);
  client.kill(); // no throw
});

test("client: kill() terminates a server that never answers shutdown", async () => {
  const client = LspClient.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]); // ignores the protocol
  await client.shutdown(300);
  assert.equal(client.exited, true);
});
