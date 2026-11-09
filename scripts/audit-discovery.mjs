#!/usr/bin/env node
// Credential-free end-to-end matrix; optional entrypoint permits published-byte comparison.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const entry=resolve(process.argv[2] || "src/index.js");
const output=process.argv[3];
if (!existsSync(resolve(entry, "../../data/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx"))) throw new Error("Audit requires the bundled offline model; refusing a download fallback");
const client=new Client({name:"discovery-audit",version:"1"},{capabilities:{}});
const transport=new StdioClientTransport({command:process.execPath,args:[entry],stderr:"pipe",env:{PATH:process.env.PATH,HOME:process.env.HOME,THE_GRAPH_STUDIO_API_KEY:"",GRAPH_STUDIO_API_KEY:"",GATEWAY_API_KEY:""}});
transport.stderr?.on("data",()=>{});
const factory="0x1F98431c8aD98523631AE4a59f267346ea31F984";
const cases=[
 ["chain-only Arc", "search_subgraphs",{query:"arc",limit:3},r=>r.subgraphs?.every(x=>x.network==="arc") && r.subgraphs.length>0],
 ["explicit Arc", "search_subgraphs",{network:"arc",limit:5},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="arc")],
 ["Arc testnet distinct", "search_subgraphs",{network:"arc-testnet",limit:3},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="arc-testnet" && x.testnet)],
 ["Ethereum alias", "search_subgraphs",{query:"uniswap v3",network:"ETHEREUM",limit:3},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="mainnet")],
 ["Polygon alias", "search_subgraphs",{network:"polygon",limit:3},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="matic")],
 ["unknown chain explanation", "search_subgraphs",{network:"arcc",limit:3},r=>r.total===0 && !!r.diagnostics],
 ["ENS exact protocol", "search_subgraphs",{query:"ens",limit:3},r=>r.subgraphs?.[0]?.display_name.toLowerCase()==="ens"],
 ["Uniswap protocol version", "search_subgraphs",{query:"uniswap v4",network:"base",limit:3},r=>/uniswap.*v4|uniswap.*v.?4/i.test(r.subgraphs?.[0]?.display_name||"")],
 ["protocol entity composition", "search_subgraphs",{network:"arbitrum",protocol_type:"lending",entity:"liquidation",limit:3},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="arbitrum-one"&&x.canonical_entities.includes("liquidation"))],
 ["new network Monad", "search_subgraphs",{network:"monad",limit:3},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="monad")],
 ["hidden allocation explanation", "search_subgraphs",{query:"tolly-arc-mainnet",network:"arc",limit:3},r=>r.total===0 && r.diagnostics?.excluded_by?.no_active_allocation>0],
 ["zero allocation opt-in", "search_subgraphs",{query:"tolly-arc-mainnet",network:"arc",include_unserved:true,limit:3},r=>r.subgraphs?.some(x=>x.active_allocation_count===0)],
 ["denied opt-in visible", "search_subgraphs",{network:"arc",include_denied:true,include_unserved:true,limit:20},r=>r.subgraphs?.some(x=>x.denied)],
 ["default testnet exclusion", "search_subgraphs",{query:"uniswap",limit:5},r=>r.subgraphs?.every(x=>!x.testnet)],
 ["fresh candidates companion", "search_subgraphs",{query:"uniswap",limit:3},r=>r.emerging?.length>0 && !!r.emerging_caveat],
 ["contract mixed case", "find_by_contract",{address:factory,chain:"ethereum",limit:3},r=>r.total>0 && r.contract_address===factory.toLowerCase() && r.deployments.every(x=>x.matched_contracts.every(c=>c.network==="mainnet"))],
 ["contract chain constraint", "find_by_contract",{address:factory,chain:"arc",limit:3},r=>r.total===0],
 ["contract malformed", "find_by_contract",{address:"0x123",chain:"mainnet"},r=>!!r.error],
 ["goal bounded payload", "query_for_goal",{goal:"Uniswap v3 pools on Ethereum",first:2},r=>!!r.request && r.query.includes("first: 2") && r.executed===false && r.validation.live_schema==="not_checked"],
 ["semantic offline chain constraint", "semantic_search_subgraphs",{query:"liquid staking derivatives",network:"ethereum",limit:3},r=>r.subgraphs?.length>0 && r.subgraphs.every(x=>x.network==="mainnet")],
 ["goal refuses costly bound", "query_for_goal",{goal:"uniswap",first:100},r=>!!r.error],
 ["goal execute credentials gate", "query_for_goal",{goal:"Uniswap v3",execute:true},r=>r.executed===false && r.execution_attempted===false],
 ["health credentials gate", "check_subgraph_health",{id:"7xLobfNG9xx8yM5hkxagRuPmdjCJP4Kj9vtomrn9LrRM"},r=>r.error==="credentials_required"],
 ["discovery health unobserved", "search_subgraphs",{network:"arc",limit:1},r=>r.subgraphs?.[0]?.freshness?.live===null],
 ["reject negative limit", "search_subgraphs",{network:"arc",limit:-1},r=>!!r.error],
 ["reject fractional limit", "search_subgraphs",{network:"arc",limit:1.5},r=>!!r.error && !/datatype mismatch/i.test(r.error)],
 ["reject string boolean", "search_subgraphs",{network:"arc",include_unserved:"false",limit:3},r=>!!r.error],
 ["reject unsupported pagination", "search_subgraphs",{network:"arc",offset:10,limit:3},r=>!!r.error],
 ["recommend Arc chain intent", "recommend_subgraph",{goal:"find DEX swaps on Arc",chain:"arc"},r=>r.recommendations?.length>0 && r.recommendations.every(x=>x.network==="arc")],
 ["goal Arc pool IDs", "query_for_goal",{goal:"Uniswap V4 pool IDs on Arc",chain:"arc",first:3},r=>/pools\(first: 3\) \{\s+id\s+\}/.test(r.query||"")],
 ["goal Ethereum pool IDs not tokens", "query_for_goal",{goal:"Uniswap v3 liquidity pool ids on Ethereum",first:3},r=>/\bpools\(/.test(r.query||"") && !/\btokens\(/.test(r.query||"")],
 ["goal OHLCV no misleading default", "query_for_goal",{goal:"OHLCV candles for Uniswap v4 pools on Arc",chain:"arc"},r=>r.query===null && r.goal_mapping?.hidden_candidates?.some(c=>c.entity==="Candle")],
 ["goal OHLCV explicit opt-in", "query_for_goal",{goal:"OHLCV candles for Uniswap v4 pools on Arc",chain:"arc",include_denied:true,first:2},r=>/\bcandles\(/.test(r.query||"")],
 ["goal latest swaps entity", "query_for_goal",{goal:"latest Uniswap v3 swaps on Ethereum",first:2},r=>/\bswaps\(/.test(r.query||"") && r.goal_mapping?.unmet?.some(u=>/ordering/.test(u))],
 ["goal absent entity no query", "query_for_goal",{goal:"Uniswap v3 liquidations on Ethereum"},r=>r.query===null && r.request===null],
 ["goal keyless human handoff", "query_for_goal",{goal:"Uniswap V4 pool IDs on Arc",chain:"arc"},r=>r.onboarding?.who==="human_operator" && /THE_GRAPH_STUDIO_API_KEY/.test(r.onboarding.relay_to_human||"") && /\$THE_GRAPH_STUDIO_API_KEY/.test(r.onboarding.curl_example||"")],
 ["invalid recommendation input", "recommend_subgraph",{goal:42},r=>!!r.error && !/toLowerCase/.test(r.error)],
];
const results=[];
try {
 await client.connect(transport);
 const info=client.getServerVersion(); const tools=(await client.listTools()).tools.map(t=>t.name);
 for(const [name,tool,args,expected] of cases) {
  let result,wireError;
  try { const wire=await client.callTool({name:tool,arguments:args},undefined,{timeout:30000});result=JSON.parse(wire.content[0].text);wireError=wire.isError; }
  catch(e){result={error:e.message};wireError=true;}
  const passed=!!expected(result);
  results.push({name,tool,args,passed,wireError,result});
  console.log(JSON.stringify({name,passed,error:result.error,total:result.total,top:(result.subgraphs||result.recommendations||result.deployments||[]).slice(0,3).map(x=>({name:x.display_name,network:x.network})),selected:result.selected?.display_name,query:result.query}));
 }
 const report={entry,server:info,tools,count:results.length,passed:results.filter(x=>x.passed).length,results};
 if(output) writeFileSync(output,JSON.stringify(report,null,2)+"\n");
 console.log(JSON.stringify({summary:true,count:report.count,passed:report.passed,server:info,toolCount:tools.length}));
 process.exitCode = report.passed === report.count ? 0 : 1;
} finally { await client.close(); }
