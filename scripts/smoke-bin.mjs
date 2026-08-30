#!/usr/bin/env node
/**
 * Packs the tarball, installs it into a temp dir, and drives the installed
 * node_modules/.bin/ symlink through a real MCP handshake.
 *
 * This exists because the test suite could not catch the bug that made every
 * npx launch fail: it ran `node src/index.js`, which satisfied the old
 * `basename(argv[1]) === "index.js"` entrypoint check, while npm's bin symlink
 * satisfied neither branch and the server exited 0 without starting. Testing
 * the source path can never catch a bug in how the PACKAGE is launched — only
 * launching the package can.
 *
 *   node scripts/smoke-bin.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "srm-smoke-"));
let failed = false;

try {
  process.stderr.write("packing...\n");
  execFileSync("npm", ["pack", "--pack-destination", work], { cwd: root, stdio: "pipe" });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tarball");

  process.stderr.write(`installing ${tgz}...\n`);
  execFileSync("npm", ["init", "-y"], { cwd: work, stdio: "pipe" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", join(work, tgz)], {
    cwd: work, stdio: "pipe",
  });

  const bin = join(work, "node_modules", ".bin", "subgraph-registry-mcp");
  process.stderr.write(`driving ${bin}\n`);

  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const done = (c, why) => { if (!settled) { settled = true; process.stderr.write(why + "\n"); try { p.kill(); } catch {} resolve(c); } };

    p.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes('"tools"')) {
        const n = (out.match(/"name":/g) || []).length;
        done(0, `OK: handshake completed over the installed bin, ${n} tool entries`);
      }
    });
    // The failure mode is a SILENT exit 0 before the handshake, so an exit
    // without a tools/list reply is the bug, not a pass.
    p.on("exit", (c, s) => done(1, `FAIL: bin exited early (code=${c} signal=${s}) before answering tools/list`));
    p.on("error", (e) => done(1, `FAIL: could not spawn: ${e.message}`));

    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }) + "\n");
    setTimeout(() => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"), 500);
    setTimeout(() => done(1, "FAIL: no tools/list reply within 60s"), 60_000);
  });
  failed = code !== 0;
} catch (err) {
  process.stderr.write(`FAIL: ${err.message}\n`);
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
