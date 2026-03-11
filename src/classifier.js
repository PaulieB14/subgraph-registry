/**
 * Subgraph Classifier
 *
 * Takes raw crawled subgraph data and classifies each subgraph into:
 * - Domain (DeFi, NFTs, DAOs, Gaming, Identity, Infrastructure, Social, Analytics)
 * - Protocol type (DEX, Lending, Bridge, Staking, Options, Derivatives, Marketplace, etc.)
 * - Canonical entities (maps schema entities to a standard vocabulary)
 * - Schema family (groups clones/forks with similar schemas)
 * - Reliability score (composite of signal, stake, query fees, query volume)
 */

// ============================================================
// Domain Classification Rules
// ============================================================

const DOMAIN_KEYWORDS = {
  defi: {
    schema: ['swap', 'pool', 'liquidity', 'vault', 'borrow', 'lend', 'stake', 'deposit', 'withdraw',
             'collateral', 'debt', 'interest', 'yield', 'farm', 'reward', 'fee', 'amm', 'pair',
             'reserve', 'flash', 'leverage', 'margin', 'perpetual', 'option', 'strike', 'premium',
             'bridge', 'wrap', 'mint', 'burn', 'token', 'erc20'],
    name: ['swap', 'dex', 'exchange', 'lend', 'borrow', 'vault', 'yield', 'farm', 'stake',
           'bridge', 'amm', 'pool', 'finance', 'fi', 'perp', 'option', 'derivative'],
  },
  nfts: {
    schema: ['nft', 'erc721', 'erc1155', 'tokenuri', 'collection', 'metadata', 'royalt',
             'auction', 'bid', 'listing', 'offer', 'marketplace'],
    name: ['nft', 'collectible', 'art', 'punk', 'ape', 'bayc', 'opensea', 'blur', 'marketplace',
           'gallery', 'auction'],
  },
  dao: {
    schema: ['proposal', 'vote', 'governor', 'timelock', 'quorum', 'delegate', 'ballot',
             'execution', 'treasury', 'multisig'],
    name: ['dao', 'govern', 'vote', 'snapshot', 'compound-gov', 'nouns', 'treasury'],
  },
  gaming: {
    schema: ['player', 'game', 'character', 'item', 'quest', 'battle', 'score', 'level',
             'achievement', 'inventory', 'world'],
    name: ['game', 'play', 'metaverse', 'world', 'quest', 'battle', 'loot'],
  },
  identity: {
    schema: ['domain', 'resolver', 'registration', 'name', 'record', 'reverse', 'registrar',
             'label', 'subdomain'],
    name: ['ens', 'name', 'identity', 'did', 'lens', 'space-id', 'unstoppable'],
  },
  infrastructure: {
    schema: ['indexer', 'delegator', 'curator', 'epoch', 'allocation', 'subgraph', 'network',
             'operator', 'oracle', 'keeper', 'registry', 'proxy'],
    name: ['graph', 'network', 'chainlink', 'oracle', 'keeper', 'infra', 'registry', 'proxy'],
  },
  social: {
    schema: ['profile', 'post', 'comment', 'follow', 'publication', 'mirror', 'collect',
             'reaction', 'feed'],
    name: ['lens', 'social', 'farcaster', 'mirror', 'forum', 'community'],
  },
  analytics: {
    schema: ['daydata', 'hourdata', 'snapshot', 'metric', 'stat', 'aggregate', 'historical'],
    name: ['analytics', 'stats', 'metrics', 'dashboard', 'data'],
  },
};

// ============================================================
// Protocol Type Classification
// ============================================================

const PROTOCOL_TYPE_RULES = [
  {
    type: 'dex',
    schemaIndicators: ['swap', 'pair', 'pool', 'amm', 'route', 'liquidity'],
    nameIndicators: ['swap', 'dex', 'exchange', 'amm', 'uniswap', 'sushi', 'curve', 'balancer',
                     'pancake', 'trader-joe', 'camelot', 'velodrome', 'aerodrome'],
    minMatches: 2,
  },
  {
    type: 'lending',
    schemaIndicators: ['borrow', 'lend', 'collateral', 'liquidat', 'repay', 'debt', 'interest', 'reserve'],
    nameIndicators: ['aave', 'compound', 'lend', 'borrow', 'maker', 'morpho', 'spark', 'silo'],
    minMatches: 2,
  },
  {
    type: 'bridge',
    schemaIndicators: ['bridge', 'relay', 'message', 'cross-chain', 'destination', 'source'],
    nameIndicators: ['bridge', 'hop', 'stargate', 'across', 'wormhole', 'layerzero', 'synapse'],
    minMatches: 1,
  },
  {
    type: 'staking',
    schemaIndicators: ['stake', 'unstake', 'validator', 'delegation', 'slash', 'epoch', 'withdrawal'],
    nameIndicators: ['staking', 'stake', 'lido', 'rocket', 'eigenlayer', 'restake'],
    minMatches: 2,
  },
  {
    type: 'options',
    schemaIndicators: ['option', 'strike', 'premium', 'expir', 'exercise', 'call', 'put'],
    nameIndicators: ['option', 'premia', 'dopex', 'lyra', 'hegic', 'opyn'],
    minMatches: 2,
  },
  {
    type: 'perpetuals',
    schemaIndicators: ['perpetual', 'perp', 'position', 'margin', 'leverage', 'funding', 'liquidat'],
    nameIndicators: ['perp', 'gmx', 'gains', 'kwenta', 'dydx', 'perpetual'],
    minMatches: 2,
  },
  {
    type: 'nft-marketplace',
    schemaIndicators: ['listing', 'bid', 'auction', 'offer', 'collection', 'sale', 'royalt'],
    nameIndicators: ['opensea', 'blur', 'rarible', 'foundation', 'superrare', 'marketplace'],
    minMatches: 2,
  },
  {
    type: 'yield-aggregator',
    schemaIndicators: ['vault', 'strategy', 'harvest', 'yield', 'apy', 'compound'],
    nameIndicators: ['yearn', 'beefy', 'harvest', 'yield', 'vault', 'convex'],
    minMatches: 2,
  },
  {
    type: 'governance',
    schemaIndicators: ['proposal', 'vote', 'governor', 'delegate', 'quorum'],
    nameIndicators: ['gov', 'dao', 'vote', 'snapshot', 'tally'],
    minMatches: 2,
  },
  {
    type: 'name-service',
    schemaIndicators: ['domain', 'resolver', 'registrar', 'registration', 'label'],
    nameIndicators: ['ens', 'name', 'domain', 'space-id', 'unstoppable'],
    minMatches: 2,
  },
];

// ============================================================
// Canonical Entity Vocabulary
// ============================================================

const CANONICAL_ENTITIES = {
  // DeFi primitives
  liquidity_pool: ['pool', 'pair', 'market', 'ammpool', 'liquiditypool'],
  trade: ['swap', 'trade', 'exchange', 'fill', 'order'],
  token: ['token', 'asset', 'erc20', 'currency', 'coin'],
  position: ['position', 'stake', 'deposit', 'userposition', 'liquidityprovider'],
  vault: ['vault', 'strategy', 'farm'],
  loan: ['borrow', 'loan', 'debt', 'borrowposition'],
  collateral: ['collateral', 'reserve', 'supply'],
  liquidation: ['liquidation', 'liquidationevent', 'liquidationcall'],

  // NFT
  nft_collection: ['collection', 'nftcollection', 'contract'],
  nft_item: ['nft', 'token', 'item', 'erc721token'],
  nft_transfer: ['transfer', 'nfttransfer'],
  nft_sale: ['sale', 'trade', 'listing', 'auction', 'bid', 'offer'],

  // Governance
  proposal: ['proposal', 'governanceproposal', 'vote'],
  delegate: ['delegate', 'delegator', 'voter'],

  // Identity
  domain_name: ['domain', 'name', 'registration', 'resolver'],

  // Time series
  daily_snapshot: ['daydata', 'dailysnapshot', 'day'],
  hourly_snapshot: ['hourdata', 'hourlysnapshot', 'hour'],

  // Common
  transaction: ['transaction', 'tx', 'event'],
  account: ['account', 'user', 'wallet', 'owner'],
};

// ============================================================
// Classification Functions
// ============================================================

/**
 * Extract entity names and their fields from a GraphQL schema string
 */
function parseSchemaEntities(schemaText) {
  if (!schemaText) return [];

  const entities = [];
  const entityRegex = /type\s+(\w+)\s+@entity[^{]*\{([^}]*)\}/g;
  let match;

  while ((match = entityRegex.exec(schemaText)) !== null) {
    const name = match[1];
    const body = match[2];
    const fields = [];

    const fieldRegex = /(\w+)\s*:/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      fields.push(fieldMatch[1]);
    }

    entities.push({ name, fields, fieldCount: fields.length });
  }

  return entities;
}

/**
 * Generate a schema fingerprint for clone/fork detection
 */
function schemaFingerprint(entities) {
  if (!entities.length) return null;

  // Fingerprint = sorted entity names + field counts
  const sig = entities
    .map(e => `${e.name.toLowerCase()}:${e.fieldCount}`)
    .sort()
    .join('|');

  // Simple hash
  let hash = 0;
  for (let i = 0; i < sig.length; i++) {
    const chr = sig.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(16);
}

/**
 * Classify a subgraph's domain based on schema + name analysis
 */
function classifyDomain(subgraph, entities) {
  const scores = {};
  const nameLower = (subgraph.displayName || '').toLowerCase();
  const descLower = (subgraph.description || '').toLowerCase();
  const entityNames = entities.map(e => e.name.toLowerCase());
  const allFields = entities.flatMap(e => e.fields.map(f => f.toLowerCase()));
  const schemaText = [...entityNames, ...allFields].join(' ');

  // Check existing categories first
  if (subgraph.categories?.length > 0) {
    for (const cat of subgraph.categories) {
      const catLower = cat.toLowerCase();
      if (catLower.includes('defi')) scores.defi = (scores.defi || 0) + 5;
      if (catLower.includes('nft')) scores.nfts = (scores.nfts || 0) + 5;
      if (catLower.includes('dao') || catLower.includes('governance')) scores.dao = (scores.dao || 0) + 5;
      if (catLower.includes('gaming')) scores.gaming = (scores.gaming || 0) + 5;
      if (catLower.includes('social')) scores.social = (scores.social || 0) + 5;
      if (catLower.includes('infrastructure')) scores.infrastructure = (scores.infrastructure || 0) + 5;
      if (catLower.includes('marketplace')) scores.nfts = (scores.nfts || 0) + 3;
    }
  }

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;

    // Schema keyword matches (weighted higher)
    for (const kw of keywords.schema) {
      if (schemaText.includes(kw)) score += 2;
    }

    // Name/description keyword matches
    for (const kw of keywords.name) {
      if (nameLower.includes(kw)) score += 3;
      if (descLower.includes(kw)) score += 1;
    }

    if (score > 0) {
      scores[domain] = (scores[domain] || 0) + score;
    }
  }

  // Sort by score, return top domain
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return {
    primary: sorted[0]?.[0] || 'unknown',
    confidence: sorted[0]?.[1] || 0,
    all: Object.fromEntries(sorted),
  };
}

/**
 * Classify protocol type
 */
function classifyProtocolType(subgraph, entities) {
  const nameLower = (subgraph.displayName || '').toLowerCase();
  const descLower = (subgraph.description || '').toLowerCase();
  const entityNames = entities.map(e => e.name.toLowerCase());
  const allFields = entities.flatMap(e => e.fields.map(f => f.toLowerCase()));
  const schemaText = [...entityNames, ...allFields].join(' ');

  const matches = [];

  for (const rule of PROTOCOL_TYPE_RULES) {
    let score = 0;

    for (const ind of rule.schemaIndicators) {
      if (schemaText.includes(ind)) score++;
    }
    for (const ind of rule.nameIndicators) {
      if (nameLower.includes(ind) || descLower.includes(ind)) score += 2;
    }

    if (score >= rule.minMatches) {
      matches.push({ type: rule.type, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches[0]?.type || 'general';
}

/**
 * Map schema entities to canonical vocabulary
 */
function mapCanonicalEntities(entities) {
  const mapped = [];

  for (const entity of entities) {
    const nameLower = entity.name.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const [canonical, aliases] of Object.entries(CANONICAL_ENTITIES)) {
      for (const alias of aliases) {
        if (nameLower === alias || nameLower.includes(alias) || alias.includes(nameLower)) {
          const score = nameLower === alias ? 3 : 1;
          if (score > bestScore) {
            bestMatch = canonical;
            bestScore = score;
          }
        }
      }
    }

    mapped.push({
      name: entity.name,
      canonicalType: bestMatch,
      fieldCount: entity.fieldCount,
      keyFields: entity.fields.slice(0, 10), // Top fields for reference
    });
  }

  return mapped;
}

/**
 * Compute a composite reliability score (0-1)
 */
function computeReliabilityScore(subgraph, queryVolume = 0) {
  const deployment = subgraph.deployment;
  if (!deployment) return 0;

  // Normalize on-chain metrics (log scale since values span many orders of magnitude)
  const signalScore = Math.min(1, Math.log10(Number(BigInt(deployment.signalledTokens || '0') / BigInt(1e18)) + 1) / 6);
  const stakeScore = Math.min(1, Math.log10(Number(BigInt(deployment.stakedTokens || '0') / BigInt(1e18)) + 1) / 8);
  const feeScore = Math.min(1, Math.log10(Number(BigInt(deployment.queryFeesAmount || '0') / BigInt(1e18)) + 1) / 4);
  const queryScore = Math.min(1, Math.log10(queryVolume + 1) / 8);

  // Penalties
  const deniedPenalty = deployment.deniedAt > 0 ? 0.5 : 0;

  // Weighted composite
  const raw = (
    signalScore * 0.25 +
    stakeScore * 0.25 +
    feeScore * 0.25 +
    queryScore * 0.25
  ) - deniedPenalty;

  return Math.max(0, Math.min(1, parseFloat(raw.toFixed(4))));
}

/**
 * Classify a single subgraph
 */
function classifySubgraph(subgraph, queryVolume = 0) {
  const entities = parseSchemaEntities(subgraph.schema);
  const domain = classifyDomain(subgraph, entities);
  const protocolType = classifyProtocolType(subgraph, entities);
  const canonicalEntities = mapCanonicalEntities(entities);
  const fingerprint = schemaFingerprint(entities);
  const reliabilityScore = computeReliabilityScore(subgraph, queryVolume);

  return {
    // Identity
    id: subgraph.id,
    displayName: subgraph.displayName,
    description: subgraph.description,
    website: subgraph.website,
    codeRepository: subgraph.codeRepository,
    owner: subgraph.owner,

    // Deployment
    ipfsHash: subgraph.deployment?.ipfsHash,
    network: subgraph.deployment?.network,
    poweredBySubstreams: subgraph.deployment?.poweredBySubstreams || false,

    // Classification
    domain: domain.primary,
    domainConfidence: domain.confidence,
    domainScores: domain.all,
    protocolType,
    selfReportedCategories: subgraph.categories || [],

    // Schema analysis
    schemaFingerprint: fingerprint,
    entityCount: entities.length,
    canonicalEntities: canonicalEntities.filter(e => e.canonicalType),
    allEntities: canonicalEntities.map(e => ({ name: e.name, type: e.canonicalType, fields: e.fieldCount })),

    // Signal & reliability
    reliabilityScore,
    signal: {
      signalledTokens: subgraph.deployment?.signalledTokens,
      stakedTokens: subgraph.deployment?.stakedTokens,
      queryFeesAmount: subgraph.deployment?.queryFeesAmount,
      queryVolume30d: queryVolume,
    },

    // Timestamps
    createdAt: subgraph.createdAt,
    updatedAt: subgraph.updatedAt,
  };
}

/**
 * Classify all subgraphs and detect schema families
 */
function classifyAll(subgraphs, queryVolumes = {}) {
  // Classify each
  const classified = subgraphs.map(sg => {
    const ipfs = sg.deployment?.ipfsHash;
    const qv = ipfs ? (queryVolumes[ipfs] || 0) : 0;
    return classifySubgraph(sg, qv);
  });

  // Group by schema fingerprint to detect families
  const families = {};
  for (const sg of classified) {
    if (!sg.schemaFingerprint) continue;
    if (!families[sg.schemaFingerprint]) {
      families[sg.schemaFingerprint] = [];
    }
    families[sg.schemaFingerprint].push(sg.id);
  }

  // Assign family info
  for (const sg of classified) {
    const family = families[sg.schemaFingerprint];
    if (family && family.length > 1) {
      sg.schemaFamily = {
        fingerprint: sg.schemaFingerprint,
        members: family.length,
        siblings: family.filter(id => id !== sg.id),
      };
    }
  }

  return classified;
}

export {
  classifySubgraph,
  classifyAll,
  parseSchemaEntities,
  schemaFingerprint,
  classifyDomain,
  classifyProtocolType,
  mapCanonicalEntities,
  computeReliabilityScore,
};
