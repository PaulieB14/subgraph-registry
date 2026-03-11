/**
 * Build Registry
 *
 * End-to-end pipeline that:
 * 1. Crawls the Graph Network subgraph for all active subgraphs
 * 2. Fetches 30-day query volumes for top deployments
 * 3. Classifies each subgraph (domain, protocol type, entities, reliability)
 * 4. Groups schema families (fork/clone detection)
 * 5. Outputs the agent-friendly registry as JSON
 */

import { fullCrawl, querySubgraph } from './crawler.js';
import { classifyAll, parseSchemaEntities } from './classifier.js';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
const SYNC_STATE_FILE = path.join(DATA_DIR, 'sync-state.json');

/**
 * Load previous sync state for incremental updates
 */
function loadSyncState() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf-8'));
  } catch {
    return { lastSyncTimestamp: 0, totalClassified: 0 };
  }
}

function saveSyncState(state) {
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Build domain summary stats from classified subgraphs
 */
function buildSummary(classified) {
  const byDomain = {};
  const byNetwork = {};
  const byProtocolType = {};
  const schemaFamilies = {};

  for (const sg of classified) {
    // By domain
    byDomain[sg.domain] = (byDomain[sg.domain] || 0) + 1;

    // By network
    if (sg.network) {
      byNetwork[sg.network] = (byNetwork[sg.network] || 0) + 1;
    }

    // By protocol type
    byProtocolType[sg.protocolType] = (byProtocolType[sg.protocolType] || 0) + 1;

    // Schema families
    if (sg.schemaFamily) {
      const fp = sg.schemaFamily.fingerprint;
      if (!schemaFamilies[fp]) {
        schemaFamilies[fp] = {
          fingerprint: fp,
          memberCount: sg.schemaFamily.members,
          representativeName: sg.displayName,
          domain: sg.domain,
          protocolType: sg.protocolType,
        };
      }
    }
  }

  return {
    totalSubgraphs: classified.length,
    byDomain: Object.entries(byDomain).sort((a, b) => b[1] - a[1]).reduce((o, [k, v]) => ({ ...o, [k]: v }), {}),
    byNetwork: Object.entries(byNetwork).sort((a, b) => b[1] - a[1]).reduce((o, [k, v]) => ({ ...o, [k]: v }), {}),
    byProtocolType: Object.entries(byProtocolType).sort((a, b) => b[1] - a[1]).reduce((o, [k, v]) => ({ ...o, [k]: v }), {}),
    schemaFamilyCount: Object.keys(schemaFamilies).length,
    topSchemaFamilies: Object.values(schemaFamilies)
      .sort((a, b) => b.memberCount - a.memberCount)
      .slice(0, 20),
  };
}

/**
 * Build the agent-facing quick-lookup indices
 */
function buildIndices(classified) {
  // Index: domain -> subgraphs (sorted by reliability)
  const byDomain = {};
  for (const sg of classified) {
    if (!byDomain[sg.domain]) byDomain[sg.domain] = [];
    byDomain[sg.domain].push({
      id: sg.id,
      name: sg.displayName,
      network: sg.network,
      protocolType: sg.protocolType,
      reliabilityScore: sg.reliabilityScore,
      ipfsHash: sg.ipfsHash,
    });
  }
  for (const domain of Object.keys(byDomain)) {
    byDomain[domain].sort((a, b) => b.reliabilityScore - a.reliabilityScore);
  }

  // Index: network -> subgraphs
  const byNetwork = {};
  for (const sg of classified) {
    if (!sg.network) continue;
    if (!byNetwork[sg.network]) byNetwork[sg.network] = [];
    byNetwork[sg.network].push({
      id: sg.id,
      name: sg.displayName,
      domain: sg.domain,
      protocolType: sg.protocolType,
      reliabilityScore: sg.reliabilityScore,
      ipfsHash: sg.ipfsHash,
    });
  }
  for (const net of Object.keys(byNetwork)) {
    byNetwork[net].sort((a, b) => b.reliabilityScore - a.reliabilityScore);
  }

  // Index: canonical entity -> subgraphs that expose it
  const byEntity = {};
  for (const sg of classified) {
    for (const entity of sg.canonicalEntities) {
      if (!byEntity[entity.canonicalType]) byEntity[entity.canonicalType] = [];
      byEntity[entity.canonicalType].push({
        id: sg.id,
        name: sg.displayName,
        network: sg.network,
        entityName: entity.name,
        reliabilityScore: sg.reliabilityScore,
        ipfsHash: sg.ipfsHash,
      });
    }
  }
  for (const ent of Object.keys(byEntity)) {
    byEntity[ent].sort((a, b) => b.reliabilityScore - a.reliabilityScore);
  }

  return { byDomain, byNetwork, byEntity };
}

/**
 * Main build pipeline
 */
async function buildRegistry({ maxSubgraphs = 200, incremental = false } = {}) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Subgraph Registry Builder              ║');
  console.log('╚══════════════════════════════════════════╝\n');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const syncState = loadSyncState();
  const minCreatedAt = incremental ? syncState.lastSyncTimestamp : 0;

  if (incremental && minCreatedAt > 0) {
    console.log(`Incremental mode: fetching subgraphs created after ${new Date(minCreatedAt * 1000).toISOString()}\n`);
  }

  // Step 1: Crawl
  const rawData = await fullCrawl({
    incrementalSince: minCreatedAt,
    fetchSchemasFlag: true,
    maxSubgraphs,
  });

  // Step 2: Classify
  console.log('\n=== Classifying Subgraphs ===');
  // Note: In production, we'd call get_deployment_30day_query_counts for each batch
  // For PoC, we classify without query volume (signal/stake/fees still provide good scoring)
  const classified = classifyAll(rawData.subgraphs);
  console.log(`  Classified: ${classified.length} subgraphs`);

  // Step 3: Build summary and indices
  console.log('\n=== Building Indices ===');
  const summary = buildSummary(classified);
  const indices = buildIndices(classified);

  console.log(`  Domains: ${Object.keys(summary.byDomain).join(', ')}`);
  console.log(`  Networks: ${Object.keys(summary.byNetwork).join(', ')}`);
  console.log(`  Protocol types: ${Object.keys(summary.byProtocolType).join(', ')}`);
  console.log(`  Schema families: ${summary.schemaFamilyCount}`);
  console.log(`  Canonical entities indexed: ${Object.keys(indices.byEntity).join(', ')}`);

  // Step 4: Assemble registry
  const registry = {
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    syncTimestamp: rawData.syncTimestamp,
    networkStats: rawData.networkStats,
    summary,
    indices,
    subgraphs: classified,
  };

  // Step 5: Write output
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  console.log(`\nRegistry written to ${REGISTRY_FILE}`);
  console.log(`  File size: ${(fs.statSync(REGISTRY_FILE).size / 1024).toFixed(1)} KB`);

  // Write raw crawl data too
  fs.writeFileSync(path.join(DATA_DIR, 'crawl-raw.json'), JSON.stringify(rawData, null, 2));

  // Update sync state
  saveSyncState({
    lastSyncTimestamp: rawData.syncTimestamp,
    totalClassified: classified.length,
    lastRunAt: new Date().toISOString(),
  });

  // Print report
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Registry Summary                       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Total classified: ${String(classified.length).padEnd(21)}║`);
  console.log('║                                          ║');
  console.log('║  By Domain:                              ║');
  for (const [domain, count] of Object.entries(summary.byDomain)) {
    console.log(`║    ${domain.padEnd(20)} ${String(count).padStart(5)}         ║`);
  }
  console.log('║                                          ║');
  console.log('║  Top Networks:                           ║');
  for (const [net, count] of Object.entries(summary.byNetwork).slice(0, 8)) {
    console.log(`║    ${net.padEnd(20)} ${String(count).padStart(5)}         ║`);
  }
  console.log('║                                          ║');
  console.log('║  Top Protocol Types:                     ║');
  for (const [pt, count] of Object.entries(summary.byProtocolType).slice(0, 8)) {
    console.log(`║    ${pt.padEnd(20)} ${String(count).padStart(5)}         ║`);
  }
  console.log('╚══════════════════════════════════════════╝');

  return registry;
}

// CLI entry point
const maxSubgraphs = parseInt(process.argv[2]) || 200;
const incremental = process.argv.includes('--incremental');

buildRegistry({ maxSubgraphs, incremental })
  .then(() => console.log('\nDone.'))
  .catch(err => {
    console.error('\nBuild failed:', err);
    process.exit(1);
  });
