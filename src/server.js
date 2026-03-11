/**
 * Subgraph Registry API Server
 *
 * Agent-friendly REST API for querying the classified subgraph registry.
 * No dependencies — uses Node's built-in http module.
 *
 * Endpoints:
 *   GET /subgraphs?domain=defi&network=arbitrum-one&entity=liquidity_pool&protocol_type=dex
 *   GET /subgraphs/:id
 *   GET /summary
 *   GET /networks
 *   GET /domains
 *   GET /families
 *   GET /search?q=uniswap
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const PORT = process.env.PORT || 3847;

let registry = null;

function loadRegistry() {
  const file = path.join(DATA_DIR, 'registry.json');
  if (!fs.existsSync(file)) {
    console.error('Registry not found. Run `npm run build-registry` first.');
    process.exit(1);
  }
  registry = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log(`Loaded registry: ${registry.subgraphs.length} subgraphs, generated ${registry.generatedAt}`);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data, null, 2));
}

function parseQuery(url) {
  const params = {};
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return params;
  const qs = url.slice(qIndex + 1);
  for (const pair of qs.split('&')) {
    const [key, val] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(val || '');
  }
  return params;
}

function handleRequest(req, res) {
  const url = req.url;
  const pathPart = url.split('?')[0];
  const params = parseQuery(url);

  // GET /summary
  if (pathPart === '/summary') {
    return json(res, {
      version: registry.version,
      generatedAt: registry.generatedAt,
      networkStats: registry.networkStats,
      summary: registry.summary,
    });
  }

  // GET /domains
  if (pathPart === '/domains') {
    return json(res, registry.summary.byDomain);
  }

  // GET /networks
  if (pathPart === '/networks') {
    return json(res, registry.summary.byNetwork);
  }

  // GET /families
  if (pathPart === '/families') {
    return json(res, registry.summary.topSchemaFamilies);
  }

  // GET /subgraphs/:id
  if (pathPart.startsWith('/subgraphs/') && pathPart.split('/').length === 3) {
    const id = pathPart.split('/')[2];
    const sg = registry.subgraphs.find(s => s.id === id || s.ipfsHash === id);
    if (!sg) return json(res, { error: 'Not found' }, 404);
    return json(res, sg);
  }

  // GET /subgraphs?domain=&network=&entity=&protocol_type=&q=&limit=&min_reliability=
  if (pathPart === '/subgraphs') {
    let results = registry.subgraphs;

    if (params.domain) {
      results = results.filter(s => s.domain === params.domain);
    }
    if (params.network) {
      results = results.filter(s => s.network === params.network);
    }
    if (params.protocol_type) {
      results = results.filter(s => s.protocolType === params.protocol_type);
    }
    if (params.entity) {
      results = results.filter(s =>
        s.canonicalEntities.some(e => e.canonicalType === params.entity)
      );
    }
    if (params.min_reliability) {
      const minR = parseFloat(params.min_reliability);
      results = results.filter(s => s.reliabilityScore >= minR);
    }
    if (params.substreams === 'true') {
      results = results.filter(s => s.poweredBySubstreams);
    }
    if (params.q) {
      const q = params.q.toLowerCase();
      results = results.filter(s =>
        (s.displayName || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
      );
    }

    // Sort by reliability
    results.sort((a, b) => b.reliabilityScore - a.reliabilityScore);

    const limit = parseInt(params.limit) || 50;
    const offset = parseInt(params.offset) || 0;

    return json(res, {
      total: results.length,
      limit,
      offset,
      subgraphs: results.slice(offset, offset + limit).map(s => ({
        id: s.id,
        displayName: s.displayName,
        description: s.description,
        domain: s.domain,
        protocolType: s.protocolType,
        network: s.network,
        reliabilityScore: s.reliabilityScore,
        ipfsHash: s.ipfsHash,
        entityCount: s.entityCount,
        canonicalEntities: s.canonicalEntities.map(e => e.canonicalType),
        signal: s.signal,
        poweredBySubstreams: s.poweredBySubstreams,
      })),
    });
  }

  // GET /search?q=uniswap
  if (pathPart === '/search') {
    const q = (params.q || '').toLowerCase();
    if (!q) return json(res, { error: 'Missing ?q= parameter' }, 400);

    const results = registry.subgraphs
      .filter(s =>
        (s.displayName || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        (s.protocolType || '').includes(q) ||
        (s.domain || '').includes(q)
      )
      .sort((a, b) => b.reliabilityScore - a.reliabilityScore)
      .slice(0, parseInt(params.limit) || 20)
      .map(s => ({
        id: s.id,
        displayName: s.displayName,
        domain: s.domain,
        protocolType: s.protocolType,
        network: s.network,
        reliabilityScore: s.reliabilityScore,
        ipfsHash: s.ipfsHash,
      }));

    return json(res, { query: q, results });
  }

  // Default: list endpoints
  json(res, {
    name: 'Subgraph Registry API',
    version: registry.version,
    endpoints: {
      'GET /summary': 'Registry overview and stats',
      'GET /domains': 'Domain breakdown',
      'GET /networks': 'Network breakdown',
      'GET /families': 'Top schema families (fork/clone groups)',
      'GET /subgraphs': 'Filter subgraphs - params: domain, network, protocol_type, entity, q, min_reliability, substreams, limit, offset',
      'GET /subgraphs/:id': 'Get full details for a subgraph by ID or IPFS hash',
      'GET /search?q=': 'Free-text search across names and descriptions',
    },
  });
}

loadRegistry();

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\nSubgraph Registry API running on http://localhost:${PORT}`);
  console.log(`\nExample queries:`);
  console.log(`  curl http://localhost:${PORT}/summary`);
  console.log(`  curl http://localhost:${PORT}/subgraphs?domain=defi&network=arbitrum-one`);
  console.log(`  curl http://localhost:${PORT}/search?q=uniswap`);
  console.log(`  curl http://localhost:${PORT}/subgraphs?entity=liquidity_pool&min_reliability=0.3`);
});
