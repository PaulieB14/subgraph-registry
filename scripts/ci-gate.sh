#!/usr/bin/env bash
# Release gate for the scheduled registry update (.github/workflows/update-registry.yml).
# Runs the same checks as .github/workflows/test.yml against the freshly regenerated,
# version-bumped working tree, BEFORE anything is committed, tagged or published.
# Any failure exits non-zero, which stops the workflow before commit/publish.
#
# No secrets: every Graph/gateway/x402 credential variable is unset up front, gateway
# calls in the tests are mocked, and the audits only use the bundled corpus.
set -euo pipefail
cd "$(dirname "$0")/.."

for v in THE_GRAPH_STUDIO_API_KEY GRAPH_STUDIO_API_KEY GATEWAY_API_KEY SUBGRAPH_REGISTRY_MOCK_GATEWAY \
         X402_PRIVATE_KEY X402_WALLET_PRIVATE_KEY SUBGRAPH_REGISTRY_X402 NPM_TOKEN NODE_AUTH_TOKEN CLAWHUB_CONFIG_JSON; do
  unset "$v"
done

step() { printf '\n== gate: %s ==\n' "$1"; }

step "syntax checks"
node --check src/index.js
node --check scripts/gen-openapi.js

step "classifier tests (python)"
if command -v pytest >/dev/null 2>&1 || python -c "import pytest" >/dev/null 2>&1; then
  (cd python && python -m pytest -q test_classifier.py)
else
  echo "::error::pytest is not installed; gate cannot run the classifier tests" >&2
  exit 1
fi

step "node test suite (every test/*.test.mjs)"
node --test test/*.test.mjs

step "discovery audit"
node scripts/audit-discovery.mjs > /dev/null

step "goal-relevance eval"
node scripts/eval-goal-relevance.mjs > /dev/null

step "installed-bin smoke test"
node scripts/smoke-bin.mjs

step "bundled semantic model loads offline"
node scripts/assert-semantic.js

step "DB hash / SKILL.md / version pins agree"
ACTUAL=$(shasum -a 256 data/registry.db | cut -d' ' -f1)
CONST=$(grep -A1 'EXPECTED_DB_SHA256 =' src/index.js | grep -oE '[a-f0-9]{64}' | head -1)
SKILL=$(grep -oE '[a-f0-9]{64}' SKILL.md | head -1)
if [ "$ACTUAL" != "$CONST" ] || [ "$ACTUAL" != "$SKILL" ]; then
  echo "::error::registry.db hash disagrees with EXPECTED_DB_SHA256 and/or SKILL.md" >&2
  exit 1
fi
PKG=$(node -p "require('./package.json').version")
SRV=$(node -p "require('./server.json').version")
PIN=$(grep -oE 'subgraph-registry-mcp@[0-9]+\.[0-9]+\.[0-9]+' SKILL.md | head -1 | sed 's/.*@//')
NPX=$(node -e "import('./src/index.js').then(m=>console.log(m.PINNED_NPX_PACKAGE.split('@')[1]))")
if [ "$PKG" != "$SRV" ] || [ "$PKG" != "$PIN" ] || [ "$PKG" != "$NPX" ]; then
  echo "::error::version pins disagree: package=$PKG server=$SRV SKILL=$PIN PINNED_NPX_PACKAGE=$NPX" >&2
  exit 1
fi

printf '\nGATE PASSED (version %s, db %s)\n' "$PKG" "${ACTUAL:0:12}"
