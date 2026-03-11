/**
 * Subgraph Registry Crawler
 *
 * Queries the Graph Network Arbitrum subgraph (the meta-subgraph that indexes
 * all subgraphs on the network) to pull metadata, schemas, signal data, and
 * deployment info for all active subgraphs.
 *
 * Supports incremental updates via lastSyncTimestamp.
 */

const GRAPH_NETWORK_SUBGRAPH_ID = 'DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp';
const GRAPH_GATEWAY = 'https://gateway.thegraph.com/api/subgraphs/id';
const PAGE_SIZE = 100;

// Query to pull subgraphs with all classification-relevant fields
const SUBGRAPHS_QUERY = `
  query CrawlSubgraphs($first: Int!, $skip: Int!, $minCreatedAt: Int!) {
    subgraphs(
      first: $first
      skip: $skip
      orderBy: currentSignalledTokens
      orderDirection: desc
      where: { active: true, createdAt_gte: $minCreatedAt }
    ) {
      id
      createdAt
      updatedAt
      currentSignalledTokens
      signalledTokens
      unsignalledTokens
      nameSignalAmount
      metadata {
        displayName
        description
        categories
        codeRepository
        website
        image
      }
      owner {
        id
        defaultName {
          name
        }
      }
      currentVersion {
        version
        createdAt
        subgraphDeployment {
          ipfsHash
          signalledTokens
          stakedTokens
          queryFeesAmount
          indexingRewardAmount
          curatorFeeRewards
          activeSubgraphCount
          deniedAt
          manifest {
            network
            poweredBySubstreams
            schemaIpfsHash
            startBlock
          }
        }
      }
    }
  }
`;

// Separate query to fetch schemas in batch (they can be large)
const SCHEMAS_QUERY = `
  query FetchSchemas($ids: [String!]!) {
    subgraphDeploymentManifests(where: { id_in: $ids }) {
      id
      network
      schema {
        id
        schema
      }
    }
  }
`;

const NETWORK_STATS_QUERY = `
  {
    graphNetwork(id: "1") {
      subgraphCount
      activeSubgraphCount
      totalQueryFees
      totalIndexingRewards
    }
  }
`;

async function querySubgraph(query, variables = {}) {
  const url = `${GRAPH_GATEWAY}/${GRAPH_NETWORK_SUBGRAPH_ID}`;
  const body = JSON.stringify({ query, variables });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Graph query failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

/**
 * Crawl all active subgraphs with pagination
 */
async function crawlSubgraphs(minCreatedAt = 0) {
  const allSubgraphs = [];
  let skip = 0;
  let hasMore = true;

  console.log(`Crawling subgraphs (created after ${minCreatedAt ? new Date(minCreatedAt * 1000).toISOString() : 'epoch'})...`);

  while (hasMore) {
    const data = await querySubgraph(SUBGRAPHS_QUERY, {
      first: PAGE_SIZE,
      skip,
      minCreatedAt,
    });

    const batch = data.subgraphs;
    allSubgraphs.push(...batch);

    console.log(`  Fetched ${allSubgraphs.length} subgraphs (batch: ${batch.length})...`);

    if (batch.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      skip += PAGE_SIZE;
    }

    // The Graph limits skip to 5000, so we need to use id-based pagination for large sets
    if (skip >= 5000) {
      console.log(`  Note: Reached skip limit at 5000. Use id-based cursor pagination for full crawl.`);
      hasMore = false;
    }
  }

  return allSubgraphs;
}

/**
 * Fetch schemas for a batch of deployment IPFS hashes
 */
async function fetchSchemas(ipfsHashes) {
  const schemas = {};
  // Batch in groups of 20 to avoid query size limits
  const batchSize = 20;

  for (let i = 0; i < ipfsHashes.length; i += batchSize) {
    const batch = ipfsHashes.slice(i, i + batchSize);
    try {
      const data = await querySubgraph(SCHEMAS_QUERY, { ids: batch });
      for (const manifest of data.subgraphDeploymentManifests) {
        if (manifest.schema?.schema) {
          schemas[manifest.id] = {
            network: manifest.network,
            schemaText: manifest.schema.schema,
            schemaId: manifest.schema.id,
          };
        }
      }
    } catch (err) {
      console.error(`  Schema batch fetch error: ${err.message}`);
    }
    console.log(`  Fetched schemas: ${Object.keys(schemas).length}/${ipfsHashes.length}`);
  }

  return schemas;
}

/**
 * Get network-level stats
 */
async function getNetworkStats() {
  return querySubgraph(NETWORK_STATS_QUERY);
}

/**
 * Full crawl pipeline
 */
async function fullCrawl({ incrementalSince = 0, fetchSchemasFlag = true, maxSubgraphs = 500 } = {}) {
  const startTime = Date.now();

  // 1. Get network stats
  console.log('\n=== Graph Network Stats ===');
  const stats = await getNetworkStats();
  console.log(`  Total subgraphs: ${stats.graphNetwork.subgraphCount}`);
  console.log(`  Active subgraphs: ${stats.graphNetwork.activeSubgraphCount}`);

  // 2. Crawl subgraph metadata
  console.log('\n=== Crawling Subgraphs ===');
  let subgraphs = await crawlSubgraphs(incrementalSince);

  // Limit for PoC
  if (subgraphs.length > maxSubgraphs) {
    console.log(`  Limiting to top ${maxSubgraphs} by signal for PoC`);
    subgraphs = subgraphs.slice(0, maxSubgraphs);
  }

  // 3. Deduplicate by deployment (multiple subgraphs can point to same deployment)
  const deploymentMap = new Map();
  for (const sg of subgraphs) {
    const deployment = sg.currentVersion?.subgraphDeployment;
    if (!deployment) continue;
    const hash = deployment.ipfsHash;
    if (!deploymentMap.has(hash)) {
      deploymentMap.set(hash, []);
    }
    deploymentMap.get(hash).push(sg);
  }
  console.log(`  Unique deployments: ${deploymentMap.size} (from ${subgraphs.length} subgraphs)`);

  // 4. Fetch schemas for unique deployments
  let schemas = {};
  if (fetchSchemasFlag) {
    console.log('\n=== Fetching Schemas ===');
    const ipfsHashes = [...deploymentMap.keys()];
    schemas = await fetchSchemas(ipfsHashes);
    console.log(`  Total schemas retrieved: ${Object.keys(schemas).length}`);
  }

  // 5. Assemble raw data
  const rawData = {
    crawledAt: new Date().toISOString(),
    syncTimestamp: Math.floor(Date.now() / 1000),
    networkStats: stats.graphNetwork,
    subgraphs: subgraphs.map(sg => {
      const deployment = sg.currentVersion?.subgraphDeployment;
      const ipfsHash = deployment?.ipfsHash;
      return {
        id: sg.id,
        displayName: sg.metadata?.displayName || null,
        description: sg.metadata?.description || null,
        categories: sg.metadata?.categories || [],
        codeRepository: sg.metadata?.codeRepository || null,
        website: sg.metadata?.website || null,
        owner: sg.owner?.defaultName?.name || sg.owner?.id || null,
        createdAt: sg.createdAt,
        updatedAt: sg.updatedAt,
        deployment: deployment ? {
          ipfsHash,
          network: deployment.manifest?.network || null,
          poweredBySubstreams: deployment.manifest?.poweredBySubstreams || false,
          startBlock: deployment.manifest?.startBlock || null,
          signalledTokens: deployment.signalledTokens,
          stakedTokens: deployment.stakedTokens,
          queryFeesAmount: deployment.queryFeesAmount,
          indexingRewardAmount: deployment.indexingRewardAmount,
          activeSubgraphCount: deployment.activeSubgraphCount,
          deniedAt: deployment.deniedAt,
        } : null,
        schema: ipfsHash && schemas[ipfsHash] ? schemas[ipfsHash].schemaText : null,
      };
    }),
  };

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Crawl Complete (${elapsed}s) ===`);
  console.log(`  Subgraphs: ${rawData.subgraphs.length}`);
  console.log(`  With schemas: ${rawData.subgraphs.filter(s => s.schema).length}`);
  console.log(`  With descriptions: ${rawData.subgraphs.filter(s => s.description).length}`);
  console.log(`  With categories: ${rawData.subgraphs.filter(s => s.categories?.length > 0).length}`);

  return rawData;
}

// Export for use by classifier
export { fullCrawl, querySubgraph, crawlSubgraphs, fetchSchemas, getNetworkStats };

// CLI entry point
if (process.argv[1]?.endsWith('crawler.js')) {
  const maxSubgraphs = parseInt(process.argv[2]) || 200;
  console.log(`Starting crawl (max ${maxSubgraphs} subgraphs)...`);

  fullCrawl({ maxSubgraphs, fetchSchemasFlag: true })
    .then(async (data) => {
      const fs = await import('fs');
      const lite = {
        ...data,
        subgraphs: data.subgraphs.map(s => ({
          ...s,
          schemaEntityCount: s.schema ? (s.schema.match(/type \w+/g) || []).length : 0,
          schema: undefined,
        })),
      };
      fs.writeFileSync('data/crawl-raw.json', JSON.stringify(data, null, 2));
      fs.writeFileSync('data/crawl-summary.json', JSON.stringify(lite, null, 2));
      console.log(`\nWritten to data/crawl-raw.json and data/crawl-summary.json`);
    })
    .catch(err => {
      console.error('Crawl failed:', err);
      process.exit(1);
    });
}
