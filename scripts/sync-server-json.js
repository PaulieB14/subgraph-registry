#!/usr/bin/env node
/**
 * Mirror package.json's version into server.json (the MCP Registry manifest),
 * which carries it in two places: the top-level `version` and the npm package
 * entry's `version`.
 *
 * Wired to the npm `version` lifecycle script, which runs after package.json is
 * bumped and before the release commit — so the two files cannot diverge in a
 * commit. Previously this was a thing to remember, and it was forgotten across
 * 0.9.0, 0.9.1 and 0.9.2: server.json sat at 0.8.31 while the package shipped
 * 0.9.2. CI caught it (test.yml "Verify package.json and server.json versions
 * match"), but only after three releases, and the failure masked the OpenAPI
 * drift check queued behind it.
 *
 * Idempotent — safe to run at any time. `npm run sync:server` to fix by hand.
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const srvPath = join(root, "server.json");

const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
const srv = JSON.parse(readFileSync(srvPath, "utf8"));

const before = [srv.version, ...(srv.packages || []).map((p) => p.version)];
srv.version = version;
for (const p of srv.packages || []) {
  // Only the npm entry tracks the package version; leave any other registry
  // type alone rather than assuming they release in lockstep.
  if (p.registryType === "npm") p.version = version;
}
const after = [srv.version, ...(srv.packages || []).map((p) => p.version)];

if (before.join() !== after.join()) {
  writeFileSync(srvPath, JSON.stringify(srv, null, 2) + "\n");
  console.log(`server.json: ${before.join("/")} -> ${after.join("/")}`);
} else {
  console.log(`server.json already at ${version}`);
}
