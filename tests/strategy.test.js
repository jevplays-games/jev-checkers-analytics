import test from 'node:test';import assert from 'node:assert/strict';
import { createInitialState,applyAction,getLegalActions } from '../public/games/checkers/rules.js';
import { profileFor,searchCandidates,rankCandidates,chooseLocalAction,features } from '../public/games/checkers/strategy.js';
import { buildRequest,validateAnswers,chooseJevAction,factorsFromAnswers } from '../server/jev.js';
import { testEnv,mockJev,roundedJev,position } from './helpers.js';
test('all four profiles have increasing deterministic budgets',()=>{let last=0;for(const d of ['easy','normal','hard','jev']){const p=profileFor(d);assert(p.nodes>last);last=p.nodes;}assert.throws(()=>profileFor('__proto__'));});
test('features report initial material and mobility without model arithmetic',()=>{const f=features(createInitialState());assert.equal(f.red.material,1200);assert.equal(f.white.material,1200);assert.equal(f.red.mobility,7);});
test('search deterministic at the same completed depth and node budget',()=>{const s=applyAction(createInitialState(),'m:09-13'),p=profileFor('normal'),a=searchCandidates(s,p),b=searchCandidates(s,p);assert.deepEqual(a.candidates.map(c=>[c.action.id,c.score]),b.candidates.map(c=>[c.action.id,c.score]));assert.equal(a.searchedNodes,b.searchedNodes);assert(a.searchedNodes<=p.nodes);});
test('incomplete root iteration falls back to the previous whole iteration',()=>{const p={...profileFor('jev'),nodes:1};const s=searchCandidates(createInitialState(),p);assert.equal(s.completedDepth,0);assert(s.exhausted);assert.equal(s.candidates.length,7);assert.equal(s.searchedNodes,1);});
test('immediate terminal win is prioritized',()=>{const s=searchCandidates(position({9:1,14:3}),profileFor('easy'));assert(s.tacticalWin);assert.equal(s.candidates[0].action.id,'j:09x18');});
test('typed request never contains Discord identity',()=>{const s=createInitialState(),p=profileFor('normal'),search=searchCandidates(s,p),request=buildRequest(s,search,p);assert.equal(Object.keys(request.questions).length,search.candidates.length*3);assert(!JSON.stringify(request).includes('discord'));assert(request.questions.c0_mobility.instructions.includes('candidates[0]'));});
test('Score distributions and Noul answers validate against documented response shape',()=>{const s=createInitialState(),p=profileFor('hard'),search=searchCandidates(s,{...p,nodes:100}),request=buildRequest(s,search,p),response=mockJev(request);const result=validateAnswers(response,request);assert.equal(Object.keys(result.answers).length,Object.keys(request.questions).length);});
test('Score distributions rounded to the provider grain validate instead of failing the turn',()=>{const s=createInitialState(),p=profileFor('normal'),request=buildRequest(s,searchCandidates(s,p),p),response=roundedJev(request);const result=validateAnswers(response,request);assert.equal(Object.keys(result.answers).length,Object.keys(request.questions).length);});
for(const [name,change]of Object.entries({
 'wrong model':r=>r.model='jev-latest', 'missing answer':r=>delete r.answers[Object.keys(r.answers)[0]],
 'extra answer':r=>r.answers.extra={type:'noul',noul:.1}, 'NaN score':r=>r.answers[Object.keys(r.answers)[0]].score=NaN,
 'bad distribution':r=>r.answers[Object.keys(r.answers)[0]].probabilities['0']=.5,
 'wrong score expectation':r=>r.answers[Object.keys(r.answers)[0]].score=4,
 'bad usage':r=>r.usage.input_tokens=-1,
 'bad legend':r=>r.answers[Object.keys(r.answers)[0]].legend['0']='tampered'
}))test(`rejects ${name}`,()=>{const s=createInitialState(),p=profileFor('easy'),request=buildRequest(s,searchCandidates(s,p),p),r=mockJev(request);change(r);assert.throws(()=>validateAnswers(r,request));});
test('JEV factors can change equal-budget search ordering',()=>{const p=profileFor('normal'),search=searchCandidates(createInitialState(),p);search.candidates[0].score=0;search.candidates[1].score=0;for(const c of search.candidates.slice(2))c.score=-1000;
 const factors={[search.candidates[0].action.id]:{promotion:0,mobility:0,support:0},[search.candidates[1].action.id]:{promotion:4,mobility:4,support:4}};
 assert.equal(rankCandidates(search,factors,p)[0].action.id,search.candidates[1].action.id);
});
test('real adapter boundary works with an explicit mocked provider; records request and validated response',async()=>{
 const t=await testEnv({TYPESAFE_API_KEY:'test-only',FETCH:async(_url,init)=>new Response(JSON.stringify(mockJev(JSON.parse(init.body))),{headers:{'content-type':'application/json'}})});
 const d=await chooseJevAction(createInitialState(),'easy',t.env);assert.equal(d.source,'jev');assert(getLegalActions(createInitialState()).some(a=>a.id===d.actionId));assert.equal(d.evidence.attempts.length,1);
 assert.equal(t.DB.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='jev_response_validated'").get().n,1);t.DB.close();
});
test('forced move skips provider entirely',async()=>{const t=await testEnv({FETCH:()=>{throw new Error('must not call');}});const d=await chooseJevAction(position({9:1,14:3,32:4}),'normal',t.env);assert.equal(d.source,'forced');assert.equal(d.evidence.questionCount,0);t.DB.close();});
test('unauthorized provider response is not retried',async()=>{let n=0;const t=await testEnv({TYPESAFE_API_KEY:'test',FETCH:async()=>{n++;return new Response('{}',{status:401});}});await assert.rejects(()=>chooseJevAction(createInitialState(),'easy',t.env));assert.equal(n,1);t.DB.close();});
test('transient provider failure is retried once and recorded',async()=>{let n=0;const t=await testEnv({TYPESAFE_API_KEY:'test',FETCH:async(_u,i)=>{if(++n===1)return new Response('{}',{status:529,headers:{'retry-after':'0'}});return new Response(JSON.stringify(mockJev(JSON.parse(i.body))));}});const d=await chooseJevAction(createInitialState(),'easy',t.env);assert.equal(n,2);assert.equal(d.evidence.attempts[0].status,'provider_http_529');assert.equal(d.evidence.attempts[1].status,'ok');t.DB.close();});
test('two invalid responses fail closed and preserve failed attempts',async()=>{const t=await testEnv({TYPESAFE_API_KEY:'test',FETCH:async()=>new Response('{broken')});await assert.rejects(()=>chooseJevAction(createInitialState(),'easy',t.env),e=>e.evidence.attempts.length===2);t.DB.close();});
