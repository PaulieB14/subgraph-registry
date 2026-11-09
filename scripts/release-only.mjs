#!/usr/bin/env node
// Release-only plumbing. No credentials are read by this script; official CLIs
// consume their normal environment/config. Importing it never publishes.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, lstatSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const PACKAGE = "subgraph-registry-mcp";
export const SLUG = "subgraph-registry";
export const NPM_FILES = ["LICENSE", "README.md", "package.json", "openapi.yaml",
  "src/index.js", "src/agent-discovery.js", "data/openapi.json", "data/registry.db",
  ...["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]
    .map((p) => `data/models/Xenova/all-MiniLM-L6-v2/${p}`)];
// Retain public skill instructions + server sources/metadata. Explicit allowlist
// excludes binaries, CI, tests, local auth files, and unrelated dashboard code.
export const SKILL_FILES = ["SKILL.md", "README.md", "LICENSE", "package.json", "server.json",
  "openapi.yaml", "data/openapi.json", "src/index.js", "src/agent-discovery.js"];
const hash = (bytes, alg = "sha256", enc = "hex") => createHash(alg).update(bytes).digest(enc);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const check = (ok, message) => { if (!ok) throw new Error(message); };
export function sameFiles(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((f) => expected.some((e) => e.path === f.path && e.sha256 === f.sha256)) &&
    new Set(actual.map((f) => f.path)).size === actual.length;
}
export function assertContext(env, version, sha) {
  check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || ""), "Stable x.y.z version required");
  check(/^[a-f0-9]{40}$/.test(sha || ""), "Full lowercase main commit SHA required");
  check(env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/main" && env.GITHUB_SHA === sha &&
    env.GITHUB_REPOSITORY === "PaulieB14/subgraph-registry" &&
    env.GITHUB_WORKFLOW_REF === "PaulieB14/subgraph-registry/.github/workflows/publish-only.yml@refs/heads/main",
    "Publishing is restricted to this repository's manually dispatched main workflow");
}
export function command(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8_000_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function required(bin, args, run = command) {
  const r = run(bin, args);
  const safeCode = (r.stderr + r.stdout).match(/\b(E401|E403|E404|EOTP|ENEEDAUTH)\b/)?.[1];
  check(r.status === 0, `${bin} command failed (exit ${r.status}${safeCode ? `, ${safeCode}` : ""}); no automatic publish retry`);
  return r.stdout;
}
function sourceFile(root, path) {
  check(lstatSync(join(root, path)).isFile(), `Expected regular non-symlink file: ${path}`);
  return readFileSync(join(root, path));
}
export function validateMetadata(root, version) {
  check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "Stable x.y.z version required");
  const pkg = json(join(root, "package.json"));
  const server = json(join(root, "server.json"));
  const spec = json(join(root, "data/openapi.json"));
  const skill = sourceFile(root, "SKILL.md").toString();
  check(pkg.name === PACKAGE && pkg.version === version, "Package name/version mismatch");
  check(server.version === version && server.packages.every((p) => p.version === version), "MCP metadata version mismatch");
  check(spec.info.version === version && readFileSync(join(root, "openapi.yaml"), "utf8").match(/^  version: ["']?(\d+\.\d+\.\d+)["']?\s*$/m)?.[1] === version, "OpenAPI version mismatch");
  check(skill.includes(`${PACKAGE}@${version}`) && skill.includes(`version \`${version}\``), "Skill version pins mismatch");
  const dbHash = hash(sourceFile(root, "data/registry.db"));
  check(skill.includes(`SHA-256(registry.db) = ${dbHash}`) &&
    sourceFile(root, "src/index.js").toString().match(/EXPECTED_DB_SHA256\s*=\s*"([a-f0-9]{64})"/)?.[1] === dbHash,
    "Database integrity pins mismatch");
  return pkg;
}
export function prepare(root, out, version, sha, run = command) {
  check(/^[a-f0-9]{40}$/.test(sha), "Full source SHA required");
  validateMetadata(root, version);
  mkdirSync(out, { recursive: true });
  check(readdirSync(out).length === 0, "Artifact output directory must be empty");
  const packed = JSON.parse(required("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], run));
  check(packed.length === 1, "Expected one npm package");
  const p = packed[0];
  check(p.name === PACKAGE && p.version === version && p.filename === `${PACKAGE}-${version}.tgz`, "Unexpected npm artifact identity");
  const files = NPM_FILES.map((path) => ({ path, sha256: hash(sourceFile(root, path)) }));
  check(p.files.length === files.length && new Set(p.files.map((f) => f.path)).size === files.length &&
    p.files.every((f) => NPM_FILES.includes(f.path)), "npm pack contains unexpected/missing files");
  const integrity = `sha512-${hash(readFileSync(join(out, p.filename)), "sha512", "base64")}`;
  check(p.integrity === integrity, "npm archive integrity mismatch");
  const skillFiles = SKILL_FILES.map((path) => {
    const bytes = sourceFile(root, path);
    mkdirSync(join(out, "skill", path, ".."), { recursive: true });
    copyFileSync(join(root, path), join(out, "skill", path));
    return { path, sha256: hash(bytes) };
  });
  const manifest = { package: PACKAGE, slug: SLUG, version, sha, filename: p.filename, integrity, files, skillFiles };
  verifyArchive(out, manifest);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
function verifyArchive(out, manifest) {
  const archive = join(out, manifest.filename);
  const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 1_000_000 });
  const names = listed.stdout?.trim().split("\n").sort();
  check(listed.status === 0 && JSON.stringify(names) === JSON.stringify(NPM_FILES.map((p) => `package/${p}`).sort()),
    "Archive contains unexpected/missing/duplicate paths");
  // Recheck actual archived bytes against fresh trusted checkout hashes, including
  // in publisher jobs: a manifest alone is not proof of a build artifact's content.
  for (const file of manifest.files) {
    const r = spawnSync("tar", ["-xOf", archive, `package/${file.path}`], { maxBuffer: 120_000_000 });
    check(r.status === 0 && hash(r.stdout) === file.sha256, `Packed bytes mismatch: ${file.path}`);
  }
}
function artifactPaths(directory, prefix = "") {
  return readdirSync(directory).flatMap((name) => {
    const path = prefix + name;
    const stat = lstatSync(join(directory, name));
    if (stat.isDirectory()) return artifactPaths(join(directory, name), path + "/");
    check(stat.isFile(), "Artifact symlinks/non-regular files are forbidden");
    return [path];
  });
}
export function verify(root, out, version, sha) {
  validateMetadata(root, version);
  const m = json(join(out, "manifest.json"));
  check(m.package === PACKAGE && m.slug === SLUG && m.version === version && m.sha === sha &&
    m.filename === `${PACKAGE}-${version}.tgz`, "Artifact identity/source mismatch");
  const paths = artifactPaths(out).sort();
  const expectedPaths = [m.filename, "manifest.json", ...SKILL_FILES.map((p) => `skill/${p}`)].sort();
  check(JSON.stringify(paths) === JSON.stringify(expectedPaths), "Unexpected/missing public artifact files");
  check(m.integrity === `sha512-${hash(readFileSync(join(out, m.filename)), "sha512", "base64")}`, "Downloaded archive changed");
  check(sameFiles(m.files, NPM_FILES.map((path) => ({ path, sha256: hash(sourceFile(root, path)) }))), "Source files changed");
  check(sameFiles(m.skillFiles, SKILL_FILES.map((path) => ({ path, sha256: hash(sourceFile(root, path)) }))), "Skill source changed");
  for (const f of m.skillFiles) check(hash(sourceFile(join(out, "skill"), f.path)) === f.sha256, "Skill artifact changed");
  verifyArchive(out, m);
  return m;
}
export function newerThan(version, previous) {
  check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(previous || ""), "Cannot establish stable latest version");
  const a = version.split(".").map(Number), b = previous.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
export function npmRelease(m, out, run = command) {
  const args = ["view", `${PACKAGE}@${m.version}`, "dist.integrity", "--json", "--registry=https://registry.npmjs.org"];
  const before = run("npm", args);
  if (before.status === 0) {
    check(JSON.parse(before.stdout) === m.integrity, "Immutable npm version exists with DIFFERENT bytes; refusing overwrite");
    return "already_published_identical";
  }
  let error;
  try { error = JSON.parse(before.stdout).error; } catch { /* fail closed */ }
  check(error?.code === "E404", "Cannot establish npm version absence (auth/network/error); refusing publish");
  const latest = JSON.parse(required("npm", ["view", PACKAGE, "dist-tags.latest", "--json", "--registry=https://registry.npmjs.org"], run));
  check(newerThan(m.version, latest), "Refusing to downgrade or replace npm latest");
  required("npm", ["publish", join(out, m.filename), "--ignore-scripts", "--access", "public", "--registry=https://registry.npmjs.org"], run);
  check(JSON.parse(required("npm", args, run)) === m.integrity, "npm post-publish integrity verification failed; inspect before retry");
  return "published_verified";
}
export function clawRelease(m, out, bin, run = command, onUpload = () => {}) {
  const inspect = ["inspect", SLUG, "--version", m.version, "--json"];
  const existing = run(bin, inspect);
  if (existing.status === 0) {
    const remote = JSON.parse(existing.stdout);
    check(remote.owner?.handle === "paulieb14" && remote.version?.version === m.version && sameFiles(remote.version.files, m.skillFiles),
      "Immutable ClawHub version has different/unknown files; refusing overwrite");
    return "already_public_identical";
  }
  // Only an explicit not-found allows a first upload. Auth, moderation, network
  // and all other errors fail closed. Pending versions may also be invisible:
  // duplicate/version rejections are errors, never retried or overwritten.
  check(/(?:version|skill) not found/i.test(existing.stderr + existing.stdout), "Cannot establish ClawHub version absence; refusing upload");
  const listing = JSON.parse(required(bin, ["inspect", SLUG, "--json"], run));
  check(listing.owner?.handle === "paulieb14" && newerThan(m.version, listing.latestVersion?.version), "ClawHub owner/latest mismatch; refusing upload");
  required(bin, ["whoami"], run);
  const uploaded = required(bin, ["--no-input", "skill", "publish", join(out, "skill"),
    "--slug", SLUG, "--name", PACKAGE, "--version", m.version,
    "--source-repo", "PaulieB14/subgraph-registry", "--source-commit", m.sha, "--source-ref", "main", "--source-path", ".",
    "--changelog", `v${m.version}: contract discovery, measured freshness and bounded opt-in goal queries. Source ${m.sha}.`, "--json"], run);
  check(!/invalid value|rejected|unauthorized|forbidden|not permitted/i.test(uploaded), "ClawHub rejected upload; inspect before retry");
  const accepted = JSON.parse(uploaded);
  check(accepted.ok === true && accepted.slug === SLUG && accepted.version === m.version &&
    ["submitted", "published", "pending-publication"].includes(accepted.status),
    "Unexpected ClawHub upload response; inspect manually before retry");
  const attempt = typeof accepted.attemptId === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(accepted.attemptId)
    ? accepted.attemptId : null;
  onUpload({ status: accepted.status, attemptId: attempt });
  const after = run(bin, inspect);
  if (after.status !== 0) {
    check(/(?:version|skill) not found/i.test(after.stderr + after.stdout), "Upload command accepted but verification failed; inspect manually");
    return accepted.status === "pending-publication" ? "upload_accepted_pending_scan_not_public"
      : "upload_accepted_publication_not_verified";
  }
  const remote = JSON.parse(after.stdout);
  check(remote.owner?.handle === "paulieb14" && remote.version?.version === m.version && sameFiles(remote.version.files, m.skillFiles), "ClawHub published files differ; inspect manually");
  return "published_verified";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, directory] = process.argv.slice(2);
    const version = process.env.RELEASE_VERSION;
    const sha = process.env.RELEASE_SHA;
    check(["prepare", "verify", "npm", "clawhub"].includes(mode) && directory, "Expected prepare|verify|npm|clawhub OUTPUT_DIR");
    if (mode === "npm" || mode === "clawhub") assertContext(process.env, version, sha);
    const root = process.cwd(), out = resolve(directory);
    const m = mode === "prepare" ? prepare(root, out, version, sha) : verify(root, out, version, sha);
    let status = mode === "npm" ? npmRelease(m, out) : mode === "clawhub"
      ? clawRelease(m, out, process.env.CLAWHUB_BIN, command, (e) => {
        const evidence = `ClawHub upload response: ${e.status}; attempt ${e.attemptId || "not reported"}`;
        console.log(evidence);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, evidence + "\n");
      }) : "verified";
    console.log(JSON.stringify({ platform: mode, version: m.version, sha: m.sha, status }));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${mode}: ${m.version} — ${status} (source ${m.sha})\n`);
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
