# Publish an existing merged version (without crawling)

`.github/workflows/publish-only.yml` is a **manual, main-only** alternative to
`update-registry.yml`. It publishes the already-reviewed package version and DB;
it never crawls, regenerates data, bumps a version, commits, tags, merges, pushes
main, deploys, or changes repository/account settings. Do not use the scheduled
crawler just to obtain access to publishing credentials.

## Prerequisites and dispatch

1. Review and merge the release metadata/workflow PR through the normal process.
   The new workflow cannot be safely exercised from its unmerged branch.
2. Confirm main contains the desired stable `x.y.z` in `package.json`, both
   `server.json` locations, the `SKILL.md` install/hash pins and OpenAPI metadata.
   Use a new minor version for new compatible tools (this release: **0.11.0**).
3. Existing repository secrets `NPM_TOKEN` and `CLAWHUB_CONFIG_JSON` must authorize
   the targets. Their existence is not proof of validity or package scope. Never
   retrieve/copy Aave's secrets or paste a token into chat. A failing CI token
   requires the owner to repair the repository secret through the official UI.
4. After merge, obtain the **full current main SHA** and manually dispatch on main:

   ```bash
   gh api repos/PaulieB14/subgraph-registry/commits/main --jq .sha
   # Substitute that exact SHA; this command performs publication when run.
   gh workflow run publish-only.yml --repo PaulieB14/subgraph-registry --ref main \
     -f version=0.11.0 -f main_sha=FULL_MERGED_MAIN_SHA \
     -f publish_npm=true -f publish_clawhub=true
   ```

   The requested SHA must equal the dispatch snapshot and still be current main
   when validation starts. If main advanced or the scheduled crawler bumped the
   version, stop and review the new SHA/version instead of dispatching stale input.
   The workflow shares the crawler's `update-registry` concurrency lock.

## Trust, tests and artifacts

- No push/release/PR trigger, `pull_request_target`, arbitrary ref input, workflow
  reuse, write permission, or OIDC token minting. Permissions are `contents: read`;
  checkout uses the dispatch SHA with credentials persistence disabled. Forks,
  non-main dispatches and mismatched workflow/source identities cannot publish.
- This still relies on GitHub's ordinary repository write/branch trust model:
  maintainers who can alter trusted main/workflow code can alter releases. It does
  not create branch protection, an approval environment or new access controls.
- Dependency installation, focused gateway/discovery/release tests, installed-bin
  smoke test, offline semantic-model check, metadata/hash validation and OpenAPI
  drift checks run **without publishing secrets**. The full historical Node suite
  has a pre-existing ENS ranking assertion mismatch with the bundled snapshot;
  this workflow runs the same focused suites as CI plus the release safety tests,
  rather than claiming that unrelated assertion was fixed.
- `npm pack --ignore-scripts` is inspected against twelve explicit public files.
  Every packed file's bytes and archive SHA-512 are checked. Dependencies/model/DB
  are the existing reviewed package contents; no data rebuild occurs.
- The ClawHub staging folder is an explicit nine-file allowlist: instructions,
  README/license, server sources and public metadata. It omits DB/model binaries,
  tests, CI, dashboard code and credential/config files, preserving the existing
  instruction/server discovery listing without depending on broad ignore rules.
- Only those public artifacts and a non-secret hash manifest are retained for
  seven days. Publisher jobs verify them against the checked-out source before
  credentials are supplied. No npm/ClawHub logs or auth files are uploaded.
- npm and ClawHub jobs are independent after validation. Only the final relevant
  publishing step receives its own secret. ClawHub's official CLI is pinned to
  **0.23.3**, installed without credentials or lifecycle scripts on Node 22; its
  temporary auth config is mode-restricted and removed on exit. No token values
  are printed. npm receives `NODE_AUTH_TOKEN` only for official registry commands;
  archive publication disables lifecycle scripts.

## Immutable versions and partial completion

npm target: `subgraph-registry-mcp`; ClawHub slug: `subgraph-registry`, owner
`paulieb14`, display name **subgraph-registry-mcp**. No alternate registry/slug,
version overwrite, automatic publish retry, or downgrade of `latest` is allowed.

- npm first checks the exact version. Identical archive integrity is a no-op;
  different bytes fail. Only explicit E404 permits one publish, and latest must
  be older. The exact published integrity is checked afterward. A transient
  post-publish verification failure is an error, not a reason to republish blindly.
- ClawHub first checks the exact version and its complete file hashes/owner.
  Identical public content is a no-op; differing/unknown content fails. Only an
  explicit skill/version-not-found response permits one upload, with owner/latest
  checked first. Authentication, network, moderation and ambiguous errors fail
  closed. The name is passed explicitly, never derived from a temporary folder.
- A successful ClawHub upload is **not necessarily public**. If accepted but still
  invisible to exact-version inspection, the summary says
  `upload_accepted_pending_scan_not_public` when the CLI reports pending scans,
  or `upload_accepted_publication_not_verified` if visibility/status is uncertain.
  Do not call either a publicly verified release. Public attempt/status evidence
  is retained in the run summary without dumping the authenticated CLI response.
  This CLI does not expose authoritative pending-version discovery. An invisible
  previous upload may cause a duplicate-version rejection on a later invocation;
  the workflow fails rather than overwrites/retries. Review that prior run/scan
  state; do not keep submitting the same version.
- Use `publish_npm=false` or `publish_clawhub=false` to complete only the missing
  platform, especially while a ClawHub upload is pending. No automatic tag changes
  are attempted for existing versions. If npm reports E401/E403/ENEEDAUTH or EOTP,
  stop and have the owner resolve authorization/2FA through official settings;
  local npm login is neither required by this workflow nor an auth workaround.

Confirm the final run summaries and public records:

- https://www.npmjs.com/package/subgraph-registry-mcp
- https://clawhub.ai/paulieb14/subgraph-registry

During preparation only: tests, artifact preparation/verification, static workflow
lint and ClawHub **dry-run** are safe. Do not merge, dispatch, tag or publish merely
to test this workflow.
