// Chart series follow the player, not the piece colour (orchestrator decision D8).
import test from 'node:test';import assert from 'node:assert/strict';
import { mobilitySeries,opponentName } from '../public/lib/analytics.js';
const points=[{redMobility:7,whiteMobility:7},{redMobility:8,whiteMobility:6},{redMobility:5,whiteMobility:9}];
test('human playing Red: You is the first, solid series; Jev the dashed opponent series',()=>{
 const [you,jev]=mobilitySeries(points,'red','jev');
 assert.deepEqual(you,{name:'You (Red)',values:[7,8,5],opponent:false});
 assert.deepEqual(jev,{name:'Jev (White)',values:[7,6,9],opponent:true});
});
test('human playing White (every other ranked match): You still solid, Jev still dashed',()=>{
 const [you,jev]=mobilitySeries(points,'white','jev');
 assert.deepEqual(you,{name:'You (White)',values:[7,6,9],opponent:false});
 assert.deepEqual(jev,{name:'Jev (Red)',values:[7,8,5],opponent:true});
});
test('local practice is never labelled Jev',()=>{
 assert.equal(opponentName('local'),'Local opponent');
 assert.equal(mobilitySeries(points,'red','local')[1].name,'Local opponent (White)');
});
