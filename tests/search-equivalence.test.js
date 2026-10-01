import test from 'node:test';import assert from 'node:assert/strict';
import { createInitialState,getLegalActions,getOutcome,applyAction,applyGeneratedAction,positionKey } from '../public/games/checkers/rules.js';
import { profileFor,searchCandidates,searchCandidatesReference,evaluate,evaluateReference } from '../public/games/checkers/strategy.js';
import { legalIds } from '../public/games/checkers/engine.js';
import { position } from './helpers.js';
// Equivalence of the mutable do/undo engine against the original clone-per-node implementations.
function rng(seed){let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
const strip=({searchMs,...rest})=>rest;
function randomGame(seed,maxPlies){
  const random=rng(seed),states=[];let state=createInitialState();states.push(state);
  for(let i=0;i<maxPlies&&!getOutcome(state);i++){const legal=getLegalActions(state);state=applyAction(state,legal[Math.floor(random()*legal.length)].id);states.push(state);}
  return states;
}
function randomBoard(seed){
  const random=rng(seed),pieces={},count=2+Math.floor(random()*20);
  for(let i=0;i<count;i++){const sq=1+Math.floor(random()*32),piece=1+Math.floor(random()*4);
    if((piece===1&&sq>=29)||(piece===3&&sq<=4))continue;pieces[sq]=piece;}
  return position(pieces,random()<.5?'red':'white',Math.floor(random()*60),Math.floor(random()*30));
}
// Random king-only games, kept only when they produce real repetition tables (the draw-history path).
function shuffleStates(){
  const out=[];
  for(const [pieces,toMove] of [[{1:2,32:4,10:2,23:4},'red'],[{5:2,28:4},'red'],[{14:2,19:4,30:4,3:2},'white'],[{1:2,6:4,27:4},'red'],[{6:2,11:4},'white']]){
    for(let seed=1;seed<60;seed++){
      const random=rng(seed*77),states=[];let state=position(pieces,toMove);states.push(state);
      for(let i=0;i<24&&!getOutcome(state);i++){const legal=getLegalActions(state);state=applyGeneratedAction(state,legal[Math.floor(random()*legal.length)]);states.push(state);}
      if(states.some(x=>Object.values(x.repetitions).some(v=>v>=2))){out.push(...states);break;}
    }
  }
  return out;
}
function assertEquivalent(state,profile,label){
  const a=searchCandidatesReference(state,profile),b=searchCandidates(state,profile);
  assert.deepStrictEqual(strip(b),strip(a),label);
}
test('fast move generation matches getLegalActions order and ids on random games and boards',()=>{
  let checked=0;
  const states=[];for(let g=0;g<40;g++)states.push(...randomGame(1000+g,120));for(let b=0;b<400;b++)states.push(randomBoard(5000+b));
  states.push(...shuffleStates());
  for(const state of states){assert.deepStrictEqual(legalIds(state),getLegalActions(state).map(a=>a.id));checked++;}
  assert(checked>2000);
});
test('fast evaluate matches evaluateReference for both perspectives',()=>{
  const states=[];for(let g=0;g<20;g++)states.push(...randomGame(2000+g,100));for(let b=0;b<300;b++)states.push(randomBoard(7000+b));
  for(const state of states)for(const side of ['red','white'])assert.equal(evaluate(state,side),evaluateReference(state,side));
});
test('fast search is identical to the reference at every difficulty on random game positions',()=>{
  let compared=0;
  for(let g=0;g<6;g++){
    const states=randomGame(3000+g,110);
    for(const index of [0,2,5,12,26,45,70,95])if(states[index]&&!getOutcome(states[index])){
      for(const difficulty of ['easy','normal','hard']){assertEquivalent(states[index],profileFor(difficulty),`game ${g} ply ${index} ${difficulty}`);compared++;}
      assertEquivalent(states[index],{...profileFor('jev'),nodes:1200},`game ${g} ply ${index} jev(capped)`);compared++;
    }
  }
  assert(compared>100);
});
test('fast search is identical on random boards, multi-jumps, tight budgets and repetition histories',()=>{
  const states=[];
  for(let b=0;b<45;b++){const s=randomBoard(9000+b);if(!getOutcome(s))states.push(s);}
  states.push(position({1:1,6:3,14:3,22:3,10:3,18:3,26:3},'red'),position({5:1,10:3,18:3,26:3,17:3,25:3},'red'),
    position({22:2,18:3,10:3,26:3,17:3,25:3,9:3},'red'),position({9:1,14:3}),...shuffleStates().filter((s,i)=>i%3===0&&!getOutcome(s)));
  let compared=0;
  for(const [i,state] of states.entries()){
    for(const profile of [profileFor('normal'),{...profileFor('hard'),nodes:300+(i*37)%900},{...profileFor('jev'),nodes:1500},{...profileFor('jev'),nodes:1+(i%40)},
      {...profileFor('normal'),depth:6,captureExtension:0},{...profileFor('easy'),depth:2,captureExtension:9,nodes:4000}]){
      assertEquivalent(state,profile,`state ${i} nodes ${profile.nodes} depth ${profile.depth}`);compared++;
    }
  }
  assert(compared>300);
});
test('fast search honours repetition counts carried in the state',()=>{
  const states=shuffleStates().filter(x=>!getOutcome(x));
  assert(states.some(x=>Object.values(x.repetitions).some(v=>v>=2)),'fixture must contain repeated positions');
  assert(states.some(x=>Object.values(x.repetitions).some(v=>v>=3)||getOutcome(applyGeneratedAction(x,getLegalActions(x)[0]))?.reason==='repetition'),'fixture must reach a repetition draw');
  for(const x of states.filter((_,i)=>i%2===0))for(const d of ['easy','normal','hard'])assertEquivalent(x,profileFor(d),`${positionKey(x)} ${d}`);
});
