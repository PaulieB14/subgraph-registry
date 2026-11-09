import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { assertContext, newerThan, sameFiles, prepare, verify, npmRelease, clawRelease,
  NPM_FILES, SKILL_FILES, PACKAGE, SLUG } from "../scripts/release-only.mjs";

const sha = "a".repeat(40), version = "0.11.0";
const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha, GITHUB_REPOSITORY: "PaulieB14/subgraph-registry",
  GITHUB_WORKFLOW_REF: "PaulieB14/subgraph-registry/.github/workflows/publish-only.yml@refs/heads/main" };
const ok = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
const missingNpm = { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }), stderr: "" };
const missingClaw = { status: 1, stdout: "", stderr: "Error: Version not found" };
const manifest = { version, sha, filename: `${PACKAGE}-${version}.tgz`, integrity: "sha512-example",
  skillFiles: [{ path: "SKILL.md", sha256: "hash" }] };
const remoteClaw = { owner: { handle: "paulieb14" }, version: { version, files: manifest.skillFiles } };
function sequence(results) {
  const calls = [];
  return { calls, run: (bin, args) => {
    calls.push({ bin, args }); assert.ok(results.length, "unexpected command"); return results.shift();
  } };
}

test("publishing guard accepts only explicit immutable main workflow dispatch", () => {
  assert.doesNotThrow(() => assertContext(env, version, sha));
  for (const change of [
    { GITHUB_REF: "refs/heads/release/0.11.0" }, { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace("main", "untrusted") },
    { GITHUB_REPOSITORY: "attacker/subgraph-registry" }, { GITHUB_SHA: "b".repeat(40) }, { GITHUB_ACTIONS: "false" },
  ]) assert.throws(() => assertContext({ ...env, ...change }, version, sha));
  for (const bad of ["v0.11.0", "0.11.0-beta", "0.11", "0.11.0;echo bad", "00.11.0"]) {
    assert.throws(() => assertContext(env, bad, sha));
  }
  assert.throws(() => assertContext(env, version, "main"));
});

test("latest guards and exact file comparison reject downgrade, extras and duplicates", () => {
  assert.equal(newerThan("0.11.0", "0.10.16"), true);
  assert.equal(newerThan("0.9.99", "0.10.0"), false);
  assert.equal(newerThan(version, version), false);
  assert.throws(() => newerThan(version, "unknown"));
  assert.equal(sameFiles(manifest.skillFiles, manifest.skillFiles), true);
  assert.equal(sameFiles([...manifest.skillFiles, ...manifest.skillFiles], manifest.skillFiles), false);
  assert.equal(sameFiles([{ path: "SKILL.md", sha256: "other" }], manifest.skillFiles), false);
});

test("npm identical version skips publishing and collisions fail closed", () => {
  const identical = sequence([ok(manifest.integrity)]);
  assert.equal(npmRelease(manifest, "/public", identical.run), "already_published_identical");
  assert.equal(identical.calls.length, 1);
  const collision = sequence([ok("sha512-different")]);
  assert.throws(() => npmRelease(manifest, "/public", collision.run), /DIFFERENT/);
  for (const code of ["E401", "E403", "E500"]) {
    const denied = sequence([{ ...missingNpm, stdout: JSON.stringify({ error: { code } }) }]);
    assert.throws(() => npmRelease(manifest, "/public", denied.run), /refusing publish/);
    assert.equal(denied.calls.length, 1);
  }
});

test("npm absent stable version publishes exact archive once and verifies remote integrity", () => {
  const s = sequence([missingNpm, ok("0.10.16"), ok({}), ok(manifest.integrity)]);
  assert.equal(npmRelease(manifest, "/public", s.run), "published_verified");
  const publish = s.calls.filter((c) => c.args[0] === "publish");
  assert.equal(publish.length, 1);
  assert.ok(publish[0].args.includes(`/public/${manifest.filename}`));
  assert.ok(publish[0].args.includes("--ignore-scripts"));
  const downgrade = sequence([missingNpm, ok("0.12.0")]);
  assert.throws(() => npmRelease(manifest, "/public", downgrade.run), /downgrade/);
  const failed = sequence([missingNpm, ok("0.10.16"), { status: 1, stdout: "", stderr: "OTP required" }]);
  assert.throws(() => npmRelease(manifest, "/public", failed.run), /no automatic publish retry/);
  assert.equal(failed.calls.filter((c) => c.args[0] === "publish").length, 1);
  const wrongRemote = sequence([missingNpm, ok("0.10.16"), ok({}), ok("sha512-wrong")]);
  assert.throws(() => npmRelease(manifest, "/public", wrongRemote.run), /post-publish/);
  assert.equal(wrongRemote.calls.filter((c) => c.args[0] === "publish").length, 1);
});

test("ClawHub identical public files skip upload, different files and errors stop", () => {
  const s = sequence([ok(remoteClaw)]);
  assert.equal(clawRelease(manifest, "/public", "clawhub", s.run), "already_public_identical");
  assert.equal(s.calls.length, 1);
  const collision = sequence([ok({ ...remoteClaw, version: { version, files: [] } })]);
  assert.throws(() => clawRelease(manifest, "/public", "clawhub", collision.run), /refusing overwrite/);
  const auth = sequence([{ status: 1, stdout: "", stderr: "Unauthorized" }]);
  assert.throws(() => clawRelease(manifest, "/public", "clawhub", auth.run), /refusing upload/);
});

test("ClawHub upload is explicit, preserves name/source, and reports scan pending honestly", () => {
  const s = sequence([missingClaw, ok({ owner: { handle: "paulieb14" }, latestVersion: { version: "0.10.16" } }),
    ok({ handle: "paulieb14" }), ok({ ok: true, slug: SLUG, version, status: "pending-publication", attemptId: "attempt-example" }), missingClaw]);
  assert.equal(clawRelease(manifest, "/public", "clawhub", s.run), "upload_accepted_pending_scan_not_public");
  const uploads = s.calls.filter((c) => c.args.includes("publish"));
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].args.includes(PACKAGE));
  assert.ok(uploads[0].args.includes(SLUG));
  assert.ok(uploads[0].args.includes(sha));
  const publicResult = sequence([missingClaw, ok({ owner: { handle: "paulieb14" }, latestVersion: { version: "0.10.16" } }),
    ok({}), ok({ ok: true, slug: SLUG, version, status: "published" }), ok(remoteClaw)]);
  assert.equal(clawRelease(manifest, "/public", "clawhub", publicResult.run), "published_verified");
  const unknown = sequence([missingClaw, ok({ owner: { handle: "paulieb14" }, latestVersion: { version: "0.10.16" } }),
    ok({}), ok({ ok: true, slug: SLUG, version, status: "submitted" }), missingClaw]);
  assert.equal(clawRelease(manifest, "/public", "clawhub", unknown.run), "upload_accepted_publication_not_verified");
});

test("ClawHub detects rejection despite exit zero and does not retry invisible duplicate", () => {
  const prefix = [missingClaw, ok({ owner: { handle: "paulieb14" }, latestVersion: { version: "0.10.16" } }), ok({})];
  const rejected = sequence([...prefix, ok({ ok: true, error: "versionId: invalid value" })]);
  assert.throws(() => clawRelease(manifest, "/public", "clawhub", rejected.run), /rejected/);
  const duplicate = sequence([...prefix, { status: 1, stdout: "", stderr: "Version exists (pending scan)" }]);
  assert.throws(() => clawRelease(manifest, "/public", "clawhub", duplicate.run), /no automatic publish retry/);
  assert.equal(duplicate.calls.filter((c) => c.args.includes("publish")).length, 1);
});

test("prepare and verify real npm pack with strict allowlists, version/hash pins and tamper rejection", () => {
  const temp = mkdtempSync(join(tmpdir(), "registry-release-test-"));
  const root = join(temp, "source"), out = join(temp, "out");
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    for (const path of new Set([...NPM_FILES, ...SKILL_FILES])) put(path, "public fixture");
    const dbHash = createHash("sha256").update("public fixture").digest("hex");
    put("package.json", JSON.stringify({ name: PACKAGE, version, files: NPM_FILES }));
    put("server.json", JSON.stringify({ version, packages: [{ version }] }));
    put("data/openapi.json", JSON.stringify({ info: { version } }));
    put("openapi.yaml", `info:\n  version: "${version}"\n`);
    put("SKILL.md", `npx ${PACKAGE}@${version}\nThe npm package version \`${version}\` ships\nSHA-256(registry.db) = ${dbHash}`);
    put("src/index.js", `const EXPECTED_DB_SHA256 = "${dbHash}";`);
    put(".npmrc", "//example.invalid/:_authToken=not-a-real-secret");
    const run = (bin, args) => {
      const r = spawnSync(bin, args, { cwd: root, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const m = prepare(root, out, version, sha, run);
    assert.equal(m.files.length, NPM_FILES.length);
    assert.equal(m.skillFiles.length, SKILL_FILES.length);
    assert.throws(() => prepare(root, out, version, sha, run), /must be empty/);
    assert.ok(!readFileSync(join(out, "manifest.json"), "utf8").includes("not-a-real-secret"));
    assert.equal(verify(root, out, version, sha).integrity, m.integrity);
    const originalTar = readFileSync(join(out, m.filename));
    put("README.md", "malicious archive bytes");
    const repacked = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out]).stdout)[0];
    put("README.md", "public fixture");
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...m, integrity: repacked.integrity }));
    assert.throws(() => verify(root, out, version, sha), /Packed bytes mismatch/);
    writeFileSync(join(out, m.filename), originalTar);
    writeFileSync(join(out, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(out, "skill/.npmrc"), "not-a-real-secret");
    assert.throws(() => verify(root, out, version, sha), /Unexpected/);
    unlinkSync(join(out, "skill/.npmrc"));
    assert.throws(() => verify(root, out, "0.12.0", sha), /mismatch/);
    writeFileSync(join(out, "skill/SKILL.md"), "tampered");
    assert.throws(() => verify(root, out, version, sha), /artifact changed/);
    writeFileSync(join(out, m.filename), "tampered");
    assert.throws(() => verify(root, out, version, sha), /archive changed/);
    put("src/unexpected.js", "should never ship");
    put("package.json", JSON.stringify({ name: PACKAGE, version, files: [...NPM_FILES, "src/unexpected.js"] }));
    assert.throws(() => prepare(root, join(temp, "unexpected"), version, sha, run), /unexpected/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
