import test from 'node:test';import assert from 'node:assert/strict';
import { createInitialState,getLegalActions,applyAction,getOutcome,serialize,deserialize,coords,squareAt,owner,positionKey } from '../public/games/checkers/rules.js';
import { position } from './helpers.js';
test('initial board: 12 per color, red first, exactly seven opening moves',()=>{
 const s=createInitialState();assert.equal(s.board.filter(p=>p===1).length,12);assert.equal(s.board.filter(p=>p===3).length,12);assert.equal(s.toMove,'red');
 assert.deepEqual(getLegalActions(s).map(a=>a.id),['m:09-13','m:09-14','m:10-14','m:10-15','m:11-15','m:11-16','m:12-16']);
});
test('square mapping is a bijection for all 32 playable squares',()=>{for(let sq=1;sq<=32;sq++)assert.equal(squareAt(...coords(sq)),sq);assert.equal(squareAt(-1,2),null);assert.equal(squareAt(0,0),null);});
test('a capture anywhere suppresses all quiet moves',()=>{const actions=getLegalActions(position({9:1,11:1,14:3,32:4}));assert(actions.every(a=>a.captured.length));assert(actions.some(a=>a.id==='j:09x18'));});
test('complete multi-jump path is the atomic action',()=>{const s=position({9:1,14:3,23:3,32:4});assert.deepEqual(getLegalActions(s).map(a=>a.id),['j:09x18x27']);assert.throws(()=>applyAction(s,'j:09x18'));const next=applyAction(s,'j:09x18x27');assert.equal(next.board[26],1);assert.equal(next.board[13],0);assert.equal(next.board[22],0);assert.equal(next.ply,1);});
test('branching capture paths are both available',()=>{const s=position({9:1,14:3,22:3,23:3,32:4});assert.deepEqual(getLegalActions(s).map(a=>a.id),['j:09x18x25','j:09x18x27']);});
test('a shorter complete capture is legal; there is no maximum-capture rule',()=>{const s=position({9:1,12:1,14:3,16:3,22:3,32:4});const a=getLegalActions(s);assert(a.some(x=>x.captured.length===1));assert(a.some(x=>x.captured.length===2));});
test('red men cannot capture backward',()=>{const a=getLegalActions(position({18:1,14:3,32:4}));assert(a.every(a=>!a.captured.length));assert(!a.some(a=>a.path.at(-1)===9));});
test('white men capture only toward decreasing rows',()=>{assert(getLegalActions(position({9:1,14:3,32:4},'white')).some(a=>a.id==='j:14x05'));});
test('king can capture backward',()=>{assert(getLegalActions(position({18:2,14:3,32:4})).some(a=>a.id==='j:18x09'));});
test('kings do not fly',()=>{const a=getLegalActions(position({10:2,32:4}));assert(a.every(a=>Math.abs(coords(a.path[1])[0]-coords(10)[0])===1));});
test('crowning ends a capture even when the new king could jump',()=>{const s=position({22:1,26:3,27:3});const a=getLegalActions(s);assert.deepEqual(a.map(a=>a.id),['j:22x31']);const next=applyAction(s,a[0].id);assert.equal(next.board[30],2);assert.equal(next.toMove,'white');assert.equal(next.board[26],3);});
test('quiet move crowns and ends turn',()=>{const s=position({25:1,4:4});const a=getLegalActions(s).find(a=>a.path.at(-1)===29);assert(a.promotes);assert.equal(applyAction(s,a.id).board[28],2);});
test('king may return to its start but may not capture a piece twice',()=>{const actions=getLegalActions(position({10:2,14:3,15:3,22:3,23:3,32:4}));assert(actions.some(a=>a.path.at(-1)===10&&a.captured.length===4));for(const a of actions)assert.equal(new Set(a.captured).size,a.captured.length);});
test('opponent with no pieces loses',()=>{const s=position({9:1,14:3});assert.deepEqual(getOutcome(applyAction(s,'j:09x18')),{winner:'red',reason:'no-pieces'});});
test('blocked side loses even if it has pieces',()=>{assert.deepEqual(getOutcome(position({25:1,29:3,30:3})),{winner:'white',reason:'blocked'});});
test('threefold repetition includes the side to move',()=>{let s=position({1:2,32:4});for(const id of ['m:01-05','m:32-28','m:05-01','m:28-32','m:01-05','m:32-28','m:05-01','m:28-32'])s=applyAction(s,id);assert.equal(getOutcome(s).reason,'repetition');assert.notEqual(positionKey(s),positionKey({...s,toMove:'white'}));});
test('80 quiet king plies cause a no-progress draw',()=>{const s=position({1:2,32:4},'red',79,79);assert.equal(getOutcome(applyAction(s,'m:01-05')).reason,'no-progress');});
test('man move and capture reset the no-progress clock',()=>{const s=position({9:1,32:4},'red',70,70);assert.equal(applyAction(s,'m:09-13').noProgressPly,0);const c=position({9:2,14:3,32:4},'red',70,70);assert.equal(applyAction(c,'j:09x18').noProgressPly,0);});
test('decisive outcomes take precedence over draw counters',()=>{const s=position({25:1,29:3,30:3},'red',80,80);assert.equal(getOutcome(s).reason,'blocked');});
test('actions do not mutate input state',()=>{const s=createInitialState(),before=serialize(s);applyAction(s,'m:09-13');assert.equal(serialize(s),before);});
test('illegal and terminal actions are rejected',()=>{assert.throws(()=>applyAction(createInitialState(),'m:01-32'));assert.throws(()=>applyAction(position({1:2}),'m:01-05'));});
test('serialization round-trips and rejects version or schema tampering',()=>{const s=createInitialState();assert.deepEqual(deserialize(serialize(s)),s);for(const bad of [{...s,board:[0]},{...s,toMove:'green'},{...s,ply:-1},{...s,repetitions:{}},{...s,rulesVersion:'international'}])assert.throws(()=>deserialize(bad));});
test('men on crown rows are rejected by imports',()=>{assert.throws(()=>deserialize(position({29:1,32:4})));});
test('randomized legal trajectories preserve invariants, counts and determinism',()=>{
 let seed=0x5eed;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};let transitions=0;
 for(let game=0;game<60;game++){let state=createInitialState();for(let ply=0;ply<180&&!getOutcome(state);ply++){
  const actions=getLegalActions(state),action=actions[rng()%actions.length],before=state.board.filter(Boolean).length;
  const next=applyAction(state,action.id);assert.equal(before-next.board.filter(Boolean).length,action.captured.length);
  assert.deepEqual(applyAction(deserialize(serialize(state)),action.id),next);assert.notEqual(state,next);deserialize(next);state=next;transitions++;
 }}assert(transitions>1500);
});
