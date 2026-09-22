import test from 'node:test';import assert from 'node:assert/strict';
import { createInitialState,getLegalActions,applyAction } from '../public/games/checkers/rules.js';
import { profileFor } from '../public/games/checkers/strategy.js';
import { sha256,hashState,sealEvent,verifyReplay } from '../public/lib/audit.js';
import { analyzeReplay,distribution,toCSV } from '../public/lib/analytics.js';
import { makeZip } from '../public/lib/zip.js';
async function fixture(){
 const initial=createInitialState(),profile=profileFor('easy'),manifest={matchId:'audit-fixture',initialState:initial,officialStart:true,humanSide:'red',opponent:'local',profile,profileHash:await sha256(profile),trust:'untrusted_client'};
 let state=initial,head=await sha256(manifest);const events=[];
 for(let i=0;i<4;i++){const action=getLegalActions(state)[0],next=applyAction(state,action.id);const e=await sealEvent({matchId:manifest.matchId,seq:i+1,at:'2026-09-22T00:00:00.000Z',kind:'move',actor:i%2?'opponent':'human',action,
  evidence:i%2?{source:'local',model:null,totalMs:i*10,searchMs:5,searchedNodes:10,completedDepth:1,legalCount:7,evaluatedCount:7,attempts:[],candidates:[]}: {},turnMs:100,preHash:await hashState(state),postHash:await hashState(next)},head);events.push(e);head=e.eventHash;state=next;}
 return {format:'jev-checkers-audit',version:1,manifest,events,finalState:state,finalHash:head,outcome:null};
}
test('complete audit record verifies offline without network',async()=>{const r=await fixture(),v=await verifyReplay(r);assert(v.valid);assert.equal(v.eventCount,4);assert.deepEqual(v.state,r.finalState);});
for(const [name,change]of Object.entries({
 'action tamper':r=>r.events[0].action.id='m:01-32', 'evidence tamper':r=>r.events[1].evidence.totalMs=999,
 'missing event':r=>r.events.splice(1,1), 'outcome tamper':r=>r.outcome={winner:'red',reason:'blocked'},
 'profile tamper':r=>r.manifest.profile.nodes=5, 'final-state tamper':r=>r.finalState.board[0]=0,
 'wrong chain head':r=>r.finalHash='0'.repeat(64)
}))test(`detects ${name}`,async()=>{const r=await fixture();change(r);await assert.rejects(()=>verifyReplay(r));});
test('metrics account for all recorded moves and snapshots',async()=>{const a=analyzeReplay(await fixture());assert.equal(a.turns,4);assert.equal(a.moves.length,4);assert.equal(a.points.length,5);assert.equal(a.heatmaps.landings.reduce((a,b)=>a+b),4);assert.equal(a.timing.opponent.count,2);assert.equal(a.sourceCounts.local,2);assert.equal(a.jev.calls,0);assert.equal(a.jev.costUSD,null);});
test('percentiles are interpolated and empty metrics remain unknown',()=>{assert.deepEqual(distribution([]),{count:0,sum:0,min:null,max:null,mean:null,p50:null,p90:null,p95:null,p99:null});assert.equal(distribution([1,2,3,4]).p50,2.5);assert.equal(distribution([NaN,10]).mean,10);});
test('CSV prevents formula injection but preserves numeric negative values',()=>{const text=toCSV([{name:'=HYPERLINK("bad")',value:-5,other:' normal'},{name:'  +formula',value:2}]);assert(text.includes("'=HYPERLINK"));assert(text.includes('"-5"'));assert(text.includes("'  +formula"));});
test('ZIP writer emits local, central-directory and end records',async()=>{const bytes=new Uint8Array(await makeZip({'a.txt':'hello','b.json':'{}'}).arrayBuffer());const view=new DataView(bytes.buffer);assert.equal(view.getUint32(0,true),0x04034b50);assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-14,true),2);});
test('self-consistent hashes do not excuse forged move metadata',async()=>{
 const r=await fixture();r.events[0].action.captured=[20];let previous=await sha256(r.manifest);
 for(let i=0;i<r.events.length;i++){const {eventHash,previousHash,...fields}=r.events[i];r.events[i]=await sealEvent(fields,previous);previous=r.events[i].eventHash;}
 r.finalHash=previous;await assert.rejects(()=>verifyReplay(r),/metadata/);
});
test('failed JEV attempts remain in analytics even when no move was committed',async()=>{
 const r=await fixture();r.events.push({kind:'service_failure',evidence:{totalMs:8000,providerMs:7950,attempts:[{status:'provider_http_529',usage:null},{status:'provider_timeout',usage:null}]}});
 const a=analyzeReplay(r);assert.equal(a.jev.calls,2);assert.equal(a.jev.failedAttempts,2);assert.equal(a.jev.serviceFailures,1);assert.equal(a.jev.unknownUsageCalls,2);
});
