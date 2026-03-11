/**
 * Test script: Loads crawled subgraph data + schemas and runs the classifier.
 * Uses pre-fetched data to demonstrate the classification pipeline.
 */

import {
  classifyAll,
  parseSchemaEntities,
  classifyDomain,
  classifyProtocolType,
  computeReliabilityScore,
} from './classifier.js';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');

// Build test dataset from the crawl results file
function buildTestDataset() {
  const crawlFile = path.join(DATA_DIR, 'crawl-50.json');
  if (fs.existsSync(crawlFile)) {
    return JSON.parse(fs.readFileSync(crawlFile, 'utf-8'));
  }

  // If no pre-built file, generate sample data for testing the classifier
  console.log('No crawl data found, using built-in test data...\n');

  return {
    subgraphs: [
      {
        id: 'test-uniswap-v3',
        displayName: 'Uniswap-V3',
        description: 'Uniswap V3 subgraph on Ethereum mainnet',
        categories: [],
        website: 'https://uniswap.org',
        codeRepository: null,
        owner: 'uniswap',
        deployment: {
          ipfsHash: 'QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7',
          network: 'mainnet',
          poweredBySubstreams: false,
          signalledTokens: '82160817810691866493224',
          stakedTokens: '14533438000000000000000000',
          queryFeesAmount: '268272383274459472535891',
          indexingRewardAmount: '5311101870893625408967981',
          deniedAt: 0,
        },
        schema: `type Factory @entity {
  id: ID!
  poolCount: BigInt!
  txCount: BigInt!
  totalVolumeUSD: BigDecimal!
  totalVolumeETH: BigDecimal!
  totalFeesUSD: BigDecimal!
  totalFeesETH: BigDecimal!
  untrackedVolumeUSD: BigDecimal!
  totalValueLockedUSD: BigDecimal!
  totalValueLockedETH: BigDecimal!
  totalValueLockedUSDUntracked: BigDecimal!
  totalValueLockedETHUntracked: BigDecimal!
  owner: ID!
}

type Pool @entity {
  id: ID!
  createdAtTimestamp: BigInt!
  createdAtBlockNumber: BigInt!
  token0: Token!
  token1: Token!
  feeTier: BigInt!
  liquidity: BigInt!
  sqrtPrice: BigInt!
  token0Price: BigDecimal!
  token1Price: BigDecimal!
  tick: BigInt
  observationIndex: BigInt!
  volumeToken0: BigDecimal!
  volumeToken1: BigDecimal!
  volumeUSD: BigDecimal!
  untrackedVolumeUSD: BigDecimal!
  feesUSD: BigDecimal!
  txCount: BigInt!
  collectedFeesToken0: BigDecimal!
  collectedFeesToken1: BigDecimal!
  collectedFeesUSD: BigDecimal!
  totalValueLockedToken0: BigDecimal!
  totalValueLockedToken1: BigDecimal!
  totalValueLockedETH: BigDecimal!
  totalValueLockedUSD: BigDecimal!
  totalValueLockedUSDUntracked: BigDecimal!
  liquidityProviderCount: BigInt!
  poolHourData: [PoolHourData!]! @derivedFrom(field: "pool")
  poolDayData: [PoolDayData!]! @derivedFrom(field: "pool")
  mints: [Mint!]! @derivedFrom(field: "pool")
  burns: [Burn!]! @derivedFrom(field: "pool")
  swaps: [Swap!]! @derivedFrom(field: "pool")
  collects: [Collect!]! @derivedFrom(field: "pool")
  ticks: [Tick!]! @derivedFrom(field: "pool")
}

type Token @entity {
  id: ID!
  symbol: String!
  name: String!
  decimals: BigInt!
  totalSupply: BigInt!
  volume: BigDecimal!
  volumeUSD: BigDecimal!
  untrackedVolumeUSD: BigDecimal!
  feesUSD: BigDecimal!
  txCount: BigInt!
  poolCount: BigInt!
  totalValueLocked: BigDecimal!
  totalValueLockedUSD: BigDecimal!
  totalValueLockedUSDUntracked: BigDecimal!
  derivedETH: BigDecimal!
}

type Swap @entity {
  id: ID!
  transaction: Transaction!
  timestamp: BigInt!
  pool: Pool!
  token0: Token!
  token1: Token!
  sender: Bytes!
  recipient: Bytes!
  origin: Bytes!
  amount0: BigDecimal!
  amount1: BigDecimal!
  amountUSD: BigDecimal!
  sqrtPriceX96: BigInt!
  tick: BigInt!
  logIndex: BigInt
}

type Transaction @entity {
  id: ID!
  blockNumber: BigInt!
  timestamp: BigInt!
  gasUsed: BigInt!
  gasPrice: BigInt!
  mints: [Mint]! @derivedFrom(field: "transaction")
  burns: [Burn]! @derivedFrom(field: "transaction")
  swaps: [Swap]! @derivedFrom(field: "transaction")
  flashed: [Flash]! @derivedFrom(field: "transaction")
  collects: [Collect]! @derivedFrom(field: "transaction")
}

type PoolDayData @entity {
  id: ID!
  date: Int!
  pool: Pool!
  liquidity: BigInt!
  sqrtPrice: BigInt!
  token0Price: BigDecimal!
  token1Price: BigDecimal!
  tick: BigInt
  tvlUSD: BigDecimal!
  volumeToken0: BigDecimal!
  volumeToken1: BigDecimal!
  volumeUSD: BigDecimal!
  feesUSD: BigDecimal!
  txCount: BigInt!
  open: BigDecimal!
  high: BigDecimal!
  low: BigDecimal!
  close: BigDecimal!
}`,
      },
      {
        id: 'test-aave-v3',
        displayName: 'Aave V3 Ethereum',
        description: 'Aave V3 lending protocol on Ethereum',
        categories: ['DeFi'],
        website: 'https://aave.com',
        codeRepository: 'https://github.com/aave/protocol-subgraphs',
        owner: 'aave',
        deployment: {
          ipfsHash: 'QmAaveTest',
          network: 'mainnet',
          poweredBySubstreams: false,
          signalledTokens: '50000000000000000000000',
          stakedTokens: '10000000000000000000000000',
          queryFeesAmount: '100000000000000000000000',
          indexingRewardAmount: '2000000000000000000000000',
          deniedAt: 0,
        },
        schema: `type Market @entity {
  id: ID!
  name: String!
  inputToken: Token!
  outputToken: Token
  rewardTokens: [RewardToken!]
  rates: [InterestRate!]
  totalValueLockedUSD: BigDecimal!
  totalDepositBalanceUSD: BigDecimal!
  totalBorrowBalanceUSD: BigDecimal!
  inputTokenBalance: BigInt!
  inputTokenPriceUSD: BigDecimal!
  outputTokenSupply: BigInt!
  outputTokenPriceUSD: BigDecimal!
  exchangeRate: BigDecimal
  rewardTokenEmissionsAmount: [BigInt!]
  rewardTokenEmissionsUSD: [BigDecimal!]
}

type Deposit @entity {
  id: ID!
  hash: String!
  logIndex: Int!
  to: String!
  from: String!
  blockNumber: BigInt!
  timestamp: BigInt!
  market: Market!
  asset: Token!
  amount: BigInt!
  amountUSD: BigDecimal!
}

type Borrow @entity {
  id: ID!
  hash: String!
  logIndex: Int!
  to: String!
  from: String!
  blockNumber: BigInt!
  timestamp: BigInt!
  market: Market!
  asset: Token!
  amount: BigInt!
  amountUSD: BigDecimal!
}

type Liquidation @entity {
  id: ID!
  hash: String!
  logIndex: Int!
  to: String!
  from: String!
  blockNumber: BigInt!
  timestamp: BigInt!
  market: Market!
  asset: Token!
  amount: BigInt!
  amountUSD: BigDecimal!
  profitUSD: BigDecimal
}

type Token @entity {
  id: ID!
  name: String!
  symbol: String!
  decimals: Int!
}

type InterestRate @entity {
  id: ID!
  rate: BigDecimal!
  duration: Int
  maturityBlock: BigInt
  side: String!
  type: String!
}

type Account @entity {
  id: ID!
  positionCount: Int!
  positions: [Position!]! @derivedFrom(field: "account")
  deposits: [Deposit!]! @derivedFrom(field: "from")
  borrows: [Borrow!]! @derivedFrom(field: "from")
}

type Position @entity {
  id: ID!
  account: Account!
  market: Market!
  hashOpened: String!
  blockNumberOpened: BigInt!
  timestampOpened: BigInt!
  side: String!
  balance: BigInt!
  depositCount: Int!
  borrowCount: Int!
  repayCount: Int!
  liquidationCount: Int!
}`,
      },
      {
        id: 'test-ens',
        displayName: 'ENS',
        description: 'Ethereum Name Service - Domain registration and resolution',
        categories: [],
        website: 'https://ens.domains',
        codeRepository: 'https://github.com/ensdomains/ens-subgraph',
        owner: 'ensdomains',
        deployment: {
          ipfsHash: 'QmENSTest',
          network: 'mainnet',
          poweredBySubstreams: false,
          signalledTokens: '30000000000000000000000',
          stakedTokens: '8000000000000000000000000',
          queryFeesAmount: '50000000000000000000000',
          indexingRewardAmount: '1000000000000000000000000',
          deniedAt: 0,
        },
        schema: `type Domain @entity {
  id: ID!
  name: String
  labelName: String
  labelhash: Bytes
  parent: Domain
  subdomains: [Domain!]! @derivedFrom(field: "parent")
  subdomainCount: Int!
  resolvedAddress: Account
  resolver: Resolver
  ttl: BigInt
  isMigrated: Boolean!
  createdAt: BigInt!
  owner: Account!
  registrant: Account
  wrappedOwner: Account
  expiryDate: BigInt
  registration: Registration @derivedFrom(field: "domain")
  wrappedDomain: WrappedDomain @derivedFrom(field: "domain")
  events: [DomainEvent!]! @derivedFrom(field: "domain")
}

type Registration @entity {
  id: ID!
  domain: Domain!
  registrationDate: BigInt!
  expiryDate: BigInt!
  cost: BigInt
  registrant: Account!
  labelName: String
  events: [RegistrationEvent!]! @derivedFrom(field: "registration")
}

type Resolver @entity {
  id: ID!
  domain: Domain
  address: Bytes!
  addr: Account
  contentHash: Bytes
  texts: [String!]
  coinTypes: [BigInt!]
  events: [ResolverEvent!]! @derivedFrom(field: "resolver")
}

type Account @entity {
  id: ID!
  domains: [Domain!]! @derivedFrom(field: "owner")
  wrappedDomains: [WrappedDomain!] @derivedFrom(field: "owner")
  registrations: [Registration!] @derivedFrom(field: "registrant")
}`,
      },
      {
        id: 'test-premia-blue',
        displayName: 'premia-blue',
        description: 'The official subgraph for Premia Blue, the decentralized options exchange for crypto assets.',
        categories: ['DeFi', 'Marketplaces', 'Infrastructure'],
        website: 'https://premia.blue',
        codeRepository: 'https://github.com/Premian-Labs/v3-subgraph',
        owner: 'premia',
        deployment: {
          ipfsHash: 'QmdHQVHirs3yPygcgo3HNttXaFCS4pnoGiMx3aKXr192En',
          network: 'arbitrum-one',
          poweredBySubstreams: false,
          signalledTokens: '205417114570700876813779',
          stakedTokens: '40960016000000000000000000',
          queryFeesAmount: '1162551968953363600494',
          indexingRewardAmount: '13039545997425017916341824',
          deniedAt: 0,
        },
        schema: `type Factory @entity {
  id: ID!
  poolCount: BigInt!
  txCount: BigInt!
  openInterestETH: BigInt!
  openInterestUSD: BigInt!
}

type Pool @entity {
  id: ID!
  base: Token!
  quote: Token!
  optionType: String!
  strike: BigInt!
  maturity: BigInt!
  liquidity: BigInt!
  openInterest: BigInt!
  volumeUSD: BigInt!
  premiumsUSD: BigInt!
  exercisePayoutsUSD: BigInt!
}

type Option @entity {
  id: ID!
  pool: Pool!
  strike: BigInt!
  maturity: BigInt!
  optionType: String!
  premium: BigInt!
  exerciseValue: BigInt!
}

type Token @entity {
  id: ID!
  symbol: String!
  name: String!
  decimals: BigInt!
}

type Swap @entity {
  id: ID!
  pool: Pool!
  buyer: Bytes!
  seller: Bytes!
  premium: BigInt!
  size: BigInt!
  isBuy: Boolean!
  timestamp: BigInt!
}`,
      },
      {
        id: 'test-graph-network',
        displayName: 'Graph Network Arbitrum',
        description: 'The Graph Network on Arbitrum - indexer, delegator, curator, and subgraph data',
        categories: ['Infrastructure'],
        website: 'https://thegraph.com',
        codeRepository: 'https://github.com/graphprotocol/graph-network-subgraph',
        owner: 'graphprotocol',
        deployment: {
          ipfsHash: 'QmT329Bej8AwSLahmgnmi6fdYkj3rorYAcCes45gDv9aJ4',
          network: 'arbitrum-one',
          poweredBySubstreams: false,
          signalledTokens: '20000000000000000000000',
          stakedTokens: '5000000000000000000000000',
          queryFeesAmount: '10000000000000000000000',
          indexingRewardAmount: '500000000000000000000000',
          deniedAt: 0,
        },
        schema: `type Indexer @entity {
  id: ID!
  stakedTokens: BigInt!
  allocatedTokens: BigInt!
  delegatedTokens: BigInt!
  queryFeesCollected: BigInt!
  rewardsEarned: BigInt!
  allocationCount: Int!
  delegatorCount: Int!
}

type Delegator @entity {
  id: ID!
  totalStakedTokens: BigInt!
  totalUnstakedTokens: BigInt!
  stakesCount: Int!
}

type Curator @entity {
  id: ID!
  totalSignalledTokens: BigInt!
  totalUnsignalledTokens: BigInt!
  signalingCount: Int!
}

type Subgraph @entity {
  id: ID!
  displayName: String
  signalledTokens: BigInt!
  stakedTokens: BigInt!
  active: Boolean!
}

type Allocation @entity {
  id: ID!
  indexer: Indexer!
  subgraphDeployment: SubgraphDeployment!
  allocatedTokens: BigInt!
  queryFeesCollected: BigInt!
  status: String!
}

type Epoch @entity {
  id: ID!
  startBlock: Int!
  endBlock: Int!
  totalRewards: BigInt!
  queryFeeRebates: BigInt!
}`,
      },
    ],
  };
}

// Run classification
console.log('╔══════════════════════════════════════════════════╗');
console.log('║   Subgraph Classifier Test                      ║');
console.log('╚══════════════════════════════════════════════════╝\n');

const testData = buildTestDataset();
console.log(`Input: ${testData.subgraphs.length} subgraphs\n`);

// Run classifier
const classified = classifyAll(testData.subgraphs);

// Print results
for (const sg of classified) {
  console.log('─'.repeat(60));
  console.log(`${sg.displayName}`);
  console.log(`  Domain:        ${sg.domain} (confidence: ${sg.domainConfidence})`);
  console.log(`  Protocol Type: ${sg.protocolType}`);
  console.log(`  Network:       ${sg.network}`);
  console.log(`  Reliability:   ${sg.reliabilityScore}`);
  console.log(`  Entities:      ${sg.entityCount} total`);

  if (sg.canonicalEntities.length > 0) {
    console.log(`  Canonical:     ${sg.canonicalEntities.map(e => `${e.name} → ${e.canonicalType}`).join(', ')}`);
  }

  if (sg.schemaFamily) {
    console.log(`  Schema Family: ${sg.schemaFamily.fingerprint} (${sg.schemaFamily.members} members)`);
  }

  console.log(`  Domain Scores: ${JSON.stringify(sg.domainScores)}`);
  console.log(`  Categories:    ${sg.selfReportedCategories.join(', ') || '(none)'}`);
}

console.log('\n' + '═'.repeat(60));
console.log('SUMMARY');
console.log('═'.repeat(60));

const domains = {};
const types = {};
for (const sg of classified) {
  domains[sg.domain] = (domains[sg.domain] || 0) + 1;
  types[sg.protocolType] = (types[sg.protocolType] || 0) + 1;
}

console.log(`\nDomains: ${JSON.stringify(domains)}`);
console.log(`Protocol Types: ${JSON.stringify(types)}`);
console.log(`\nClassification complete.`);
