import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { callLlm } from "../dist/src/daemon/llm-provider.js";

/**
 * fetch() resolves as soon as the response HEAD is in; the body is pulled afterwards. With
 * clearTimeout sitting in a finally around the fetch alone, the abort timer was already gone by the
 * time response.json() started reading — so a server that sends headers and then stalls held the
 * call forever, no matter what timeoutMs said. [bug-211]
 *
 * The server here does exactly that: 200 + headers, then silence.
 */
function stallingServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1024" });
      res.write(" ");            // flush the head, then never finish the body
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// Hard test timeout so the counter-check against the pre-fix build FAILS instead of hanging
// forever — an unbounded hang is exactly the bug, and a test that hangs reports nothing.
test("callLlm times out while the body stalls, not just during the handshake [bug-211]", { timeout: 15_000 }, async () => {
  const { server, port } = await stallingServer();
  const cfg = {
    provider: "openai", baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "test", apiKeyEnv: "NONE",
  };
  const started = Date.now();
  await assert.rejects(
    () => callLlm(cfg, "", "hi", { timeoutMs: 1000 }),
    /timed out/,
    "a stalled body must surface as a timeout, not hang",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `should give up near timeoutMs, took ${elapsed}ms`);
  server.close();
  server.closeAllConnections?.();
});
