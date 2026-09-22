#!/usr/bin/env node
/** Reproducible paired-color experiments. Remote JEV is opt-in and never simulated. */
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform,arch,cpus } from 'node:os';
import { createInitialState,getLegalActions,getOutcome,applyAction,otherSide } from '../public/games/checkers/rules.js';
import { chooseLocalAction,profileFor,evaluate } from '../public/games/checkers/strategy.js';
import { chooseJevAction } from '../server/jev.js';
import { distribution,toCSV } from '../public/lib/analytics.js';
import { sha256 } from '../public/lib/audit.js';
import { NodeDB } from '../server/node-db.js';
function args(){const out={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(!key.startsWith('--'))throw Error('Expected named options');out[key.slice(2)]=process.argv[i+1]&&!process.argv[i+1].startsWith('--')?process.argv[++i]:true;}return out;}
function rng(seed){let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
function interval(values,seed){if(values.length<2)return null;const random=rng(seed),means=[];for(let b=0;b<1000;b++){let total=0;for(let i=0;i<values.length;i++)total+=values[Math.floor(random()*values.length)];means.push(total/values.length);}means.sort((a,b)=>a-b);return {method:'percentile bootstrap over paired starting positions',replicates:1000,lower:means[24],upper:means[974]};}
const options=args(),pairs=Number(options.pairs||4),seed=Number(options.seed||73019),profile=String(options.profile||'easy'),opponent=String(options.opponent||'random'),treatment=String(options.treatment||'search');
if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('--seed must be an unsigned 32-bit integer');
if(!Number.isInteger(pairs)||pairs<1||pairs>1000)throw Error('--pairs must be 1–1000');
if(!['random','heuristic','search','jev'].includes(opponent)||!['search','jev'].includes(treatment))throw Error('Unsupported agent');
const maxPlies=Number(options['max-plies']||240);if(!Number.isInteger(maxPlies)||maxPlies<2||maxPlies>2000)throw Error('--max-plies must be 2–2000');
const treatments=options.ablation?['search','jev']:[treatment],remote=treatments.includes('jev')||opponent==='jev';
if(remote&&(!options['allow-remote']||!process.env.TYPESAFE_API_KEY))throw Error('Remote experiments require TYPESAFE_API_KEY and explicit --allow-remote. No mock JEV will be substituted.');
const config=profileFor(profile),outdir=resolve(String(options.out||`bench/results/${new Date().toISOString().replaceAll(':','-')}`));await mkdir(outdir,{recursive:true});
const DB=new NodeDB();DB.exec(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));const env={DB,TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY};
const manifest={benchmarkVersion:1,startedAt:new Date().toISOString(),seed,pairs,treatments,opponent,maxPlies,profile:config,profileHash:await sha256(config),
  runtime:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model},remoteProviderUsed:remote,
  design:'Same legal opening in each color. Ablation uses identical search budgets; only JEV factors differ. Truncation is not a draw.'};
await writeFile(resolve(outdir,'manifest.json'),JSON.stringify(manifest,null,2));
const random=rng(seed),fixtures=[];
for(let i=0;i<pairs;i++){
  let state=createInitialState();const opening=[];const plies=6+2*(i%4);
  for(let p=0;p<plies&&!getOutcome(state);p++){const legal=getLegalActions(state),action=legal[Math.floor(random()*legal.length)];opening.push(action.id);state=applyAction(state,action.id);}
  fixtures.push({fixtureId:`opening-${String(i+1).padStart(4,'0')}`,opening,initialState:state});
}
await writeFile(resolve(outdir,'fixtures.json'),JSON.stringify(fixtures,null,2));
const games=[],decisions=[],failures=[],operations=[];
async function choose(kind,state,random){
  if(kind==='jev')return chooseJevAction(state,profile,env);
  if(kind==='search')return chooseLocalAction(state,profile);
  const start=performance.now(),legal=getLegalActions(state);let action;
  if(kind==='random')action=legal[Math.floor(random()*legal.length)];
  else action=[...legal].sort((a,b)=>{
    const utility=move=>{const next=applyAction(state,move.id),outcome=getOutcome(next);return outcome?outcome.winner===state.toMove?1e6:outcome.winner===null?0:-1e6:evaluate(next,state.toMove);};
    return utility(b)-utility(a)||(a.id<b.id?-1:a.id>b.id?1:0);
  })[0];
  return {actionId:action.id,source:kind,model:null,evidence:{totalMs:performance.now()-start,legalCount:legal.length,searchedNodes:0,completedDepth:0,attempts:[]}};
}
for(let f=0;f<fixtures.length;f++)for(const treatment of treatments)for(const side of ['red','white']){
  const fixture=fixtures[f],gameId=`${fixture.fixtureId}-${treatment}-${side}`,gameRng=rng(seed+f*100+Number(side==='white'));
  let state=structuredClone(fixture.initialState),moves=0,error=null;const actions=[];const start=performance.now();
  while(moves<maxPlies&&!getOutcome(state)){
    const agent=state.toMove===side?treatment:opponent;
    try{const before=state,decision=await choose(agent,state,gameRng);state=applyAction(state,decision.actionId);moves++;actions.push(decision.actionId);
      decisions.push({gameId,fixtureId:fixture.fixtureId,treatment,treatedSide:side,agent,ply:state.ply,side:before.toMove,actionId:decision.actionId,source:decision.source,
        totalMs:decision.evidence.totalMs,providerMs:decision.evidence.providerMs??null,nodes:decision.evidence.searchedNodes??null,depth:decision.evidence.completedDepth??null,
        legalCount:decision.evidence.legalCount,changedFromBaseline:decision.evidence.changedFromBaseline??null,attempts:decision.evidence.attempts,
        evidence:decision.evidence});
    }catch(e){error=e.code||e.name;failures.push({gameId,fixtureId:fixture.fixtureId,treatment,treatedSide:side,agent,ply:state.ply,error,evidence:e.evidence||null});break;}
  }
  const outcome=getOutcome(state);
  const score=outcome ? (outcome.winner===null ? 0.5 : (outcome.winner===side ? 1 : 0)) : null;
  games.push({gameId,fixtureId:fixture.fixtureId,treatment,treatedSide:side,opponent,status:error?'provider_or_engine_failure':outcome?'complete':'truncated',
    winner:outcome?.winner??null,reason:outcome?.reason??error??'move_cap',score,moves,durationMs:performance.now()-start,actions});
  for(const row of DB.db.prepare('SELECT * FROM operations ORDER BY created_at,id').all())operations.push({id:row.id,gameId,fixtureId:fixture.fixtureId,treatment,treatedSide:side,at:row.created_at,kind:row.kind,trust:row.trust,requestId:row.request_id,payload:JSON.parse(row.payload_json)});
  DB.exec('DELETE FROM operations');
  console.log(`${gameId}: ${games.at(-1).status} (${moves} moves)`);
}
const summaries={};
for(const t of treatments){
  const subset=games.filter(g=>g.treatment===t),complete=subset.filter(g=>g.status==='complete'),points=complete.reduce((s,g)=>s+g.score,0),unknown=subset.length-complete.length;
  const clusters=fixtures.map(f=>subset.filter(g=>g.fixtureId===f.fixtureId)).filter(g=>g.length===2&&g.every(x=>x.status==='complete')).map(g=>(g[0].score+g[1].score)/2);
  const ownDecisions=decisions.filter(d=>d.treatment===t&&d.side===d.treatedSide);
  summaries[t]={games:subset.length,completed:complete.length,truncated:subset.filter(g=>g.status==='truncated').length,failed:subset.filter(g=>g.status==='provider_or_engine_failure').length,
    wins:complete.filter(g=>g.score===1).length,draws:complete.filter(g=>g.score===.5).length,losses:complete.filter(g=>g.score===0).length,
    scoreAmongCompleted:complete.length?points/complete.length:null,completionFraction:complete.length/subset.length,
    allScheduledScoreBounds:{lower:points/subset.length,upper:(points+unknown)/subset.length},
    completePairedPositions:clusters.length,pairedMean:clusters.length?clusters.reduce((s,x)=>s+x,0)/clusters.length:null,paired95CI:interval(clusters,seed),
    treatedDecisionLatency:distribution(ownDecisions.map(d=>d.totalMs)),nodes:distribution(ownDecisions.map(d=>d.nodes)),
    jevDecisions:ownDecisions.filter(d=>d.source==='jev').length,forcedDecisions:ownDecisions.filter(d=>d.source==='forced').length,
    fallbacks:0,providerAttempts:ownDecisions.reduce((s,d)=>s+(d.attempts?.length||0),0)};
}
let ablation=null;
if(options.ablation){const diffs=[];for(const f of fixtures){const g=games.filter(g=>g.fixtureId===f.fixtureId);if(g.length===4&&g.every(g=>g.status==='complete')){
 const mean=t=>g.filter(g=>g.treatment===t).reduce((s,g)=>s+g.score,0)/2;diffs.push(mean('jev')-mean('search'));}}
 ablation={completeMatchedQuartets:diffs.length,meanJevMinusSearch:diffs.length?diffs.reduce((a,b)=>a+b)/diffs.length:null,paired95CI:interval(diffs,seed+1)};
}
const operationalAttempts=operations.filter(row=>['jev_response_validated','jev_attempt_failed'].includes(row.kind));
const summary={...manifest,finishedAt:new Date().toISOString(),summaries,ablation,operations:{count:operations.length,providerAttempts:operationalAttempts.length,failedAttempts:operationalAttempts.filter(row=>row.kind==='jev_attempt_failed').length,scope:'All benchmark attempts including uncommitted failures; treatment summary attempts cover committed decisions only.'},
 caveats:['Generated openings are a smoke-test suite, not a calibrated measure of human playing strength.','Color pairs share a starting position; uncertainty is clustered by starting position.','Truncated games are reported separately and never converted to draws.','Remote provider quality is not measured unless remoteProviderUsed is true.']};
await Promise.all([
 writeFile(resolve(outdir,'operations.ndjson'),operations.map(row=>JSON.stringify(row)).join('\n')+(operations.length?'\n':'')),
 writeFile(resolve(outdir,'failures.ndjson'),failures.map(row=>JSON.stringify(row)).join('\n')+(failures.length?'\n':'')),
 writeFile(resolve(outdir,'summary.json'),JSON.stringify(summary,null,2)),writeFile(resolve(outdir,'games.ndjson'),games.map(g=>JSON.stringify(g)).join('\n')+'\n'),
 writeFile(resolve(outdir,'games.csv'),toCSV(games.map(({actions,...g})=>g))),writeFile(resolve(outdir,'decisions.ndjson'),decisions.map(d=>JSON.stringify(d)).join('\n')+'\n'),
 writeFile(resolve(outdir,'decisions.csv'),toCSV(decisions.map(({evidence,attempts,...d})=>d)))
]);
DB.close();console.log(`Results: ${outdir}`);
