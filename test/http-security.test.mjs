// HTTP transport security (0.13.1): loopback default, token required for any
// non-loopback bind, bearer auth with 401, DNS-rebinding guard. No network
// beyond 127.0.0.1 and no gateway calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveHttpSecurity, createHttpApp, httpAuthMiddleware, isLoopbackHost, HTTP_TOKEN_ENV,
} from "../src/index.js";

const TOKEN = "test-token-" + "x".repeat(32);
const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

async function listen(app) {
  return await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const base = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("defaults to loopback-only binding", () => {
  const s = resolveHttpSecurity({});
  assert.equal(s.ok, true);
  assert.equal(s.host, "127.0.0.1");
  assert.equal(s.loopback, true);
  assert.equal(s.auth, "loopback_only");
  assert.equal(s.token, null);
  for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.1.2.3", "::ffff:127.0.0.1"]) assert.ok(isLoopbackHost(h), h);
  for (const h of ["0.0.0.0", "::", "10.0.0.5", "example.com", "127.0.0.1.evil.com", ""]) assert.ok(!isLoopbackHost(h), h);
});

test("refuses non-loopback bind without a token, and short tokens", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
    const s = resolveHttpSecurity({ MCP_HTTP_HOST: host });
    assert.equal(s.ok, false);
    assert.match(s.error, new RegExp(HTTP_TOKEN_ENV));
    assert.throws(() => createHttpApp(s), /Refusing to bind/);
  }
  const short = resolveHttpSecurity({ MCP_HTTP_HOST: "0.0.0.0", [HTTP_TOKEN_ENV]: "short" });
  assert.equal(short.ok, false);
  assert.ok(!short.error.includes("short"), "token value is never echoed");
  const ok = resolveHttpSecurity({ MCP_HTTP_HOST: "0.0.0.0", [HTTP_TOKEN_ENV]: TOKEN });
  assert.equal(ok.ok, true);
  assert.equal(ok.auth, "bearer_token");
});

test("CLI exits non-zero instead of binding 0.0.0.0 without a token", async () => {
  const env = { ...process.env, MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PORT: "0" };
  delete env[HTTP_TOKEN_ENV];
  delete env.THE_GRAPH_STUDIO_API_KEY;
  const child = spawn(process.execPath, [ENTRY, "--http-only"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 20000);
    child.on("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 1);
  assert.match(err, /Refusing to bind/);
  assert.doesNotMatch(err, /listening/);
});

test("token mode: 401 without or with wrong bearer, 200 with the right one", async () => {
  const srv = await listen(createHttpApp(resolveHttpSecurity({ MCP_HTTP_HOST: "0.0.0.0", [HTTP_TOKEN_ENV]: TOKEN })));
  try {
    const u = base(srv);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN}x` }]) {
      for (const [method, path] of [["GET", "/sse"], ["POST", "/messages?sessionId=x"], ["POST", "/graphql"], ["GET", "/.well-known/openapi.json"], ["GET", "/subgraphs/x.jsonld"]]) {
        const r = await fetch(u + path, { method, headers });
        assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
        assert.match(r.headers.get("www-authenticate") || "", /^Bearer/);
        const body = await r.text();
        assert.ok(!body.includes(TOKEN), "token never echoed");
      }
    }
    const health = await fetch(u + "/health");
    assert.equal(health.status, 200);
    const spec = await fetch(u + "/.well-known/openapi.json", { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(spec.status, 200);
    const ac = new AbortController();
    const sse = await fetch(u + "/sse", { headers: { authorization: `bearer ${TOKEN}` }, signal: ac.signal });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type") || "", /text\/event-stream/);
    ac.abort();
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test("loopback-only mode rejects foreign Host headers (DNS rebinding) and remote sockets", async () => {
  const srv = await listen(createHttpApp(resolveHttpSecurity({})));
  try {
    const u = base(srv);
    const ok = await fetch(u + "/.well-known/openapi.json");
    assert.equal(ok.status, 200);
    const { request } = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.address().port, path: "/sse", headers: { host: "attacker.example:3848" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 401);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
  const mw = httpAuthMiddleware(resolveHttpSecurity({}));
  let nextCalled = false, code = null;
  const res = { set() { return this; }, status(c) { code = c; return this; }, json() { return this; } };
  mw({ path: "/messages", socket: { remoteAddress: "10.0.0.5" }, headers: { host: "localhost:3848" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(code, 401);
});
