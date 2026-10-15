// Chart series follow the player, not the piece colour (orchestrator decision D8).
import test from 'node:test';import assert from 'node:assert/strict';
import { materialSeries,mobilitySeries,opponentName,sideName } from '../public/lib/analytics.js';
const points=[{redMobility:7,whiteMobility:7,redMaterial:1200,whiteMaterial:1200},{redMobility:8,whiteMobility:6,redMaterial:1200,whiteMaterial:1100},{redMobility:5,whiteMobility:9,redMaterial:1000,whiteMaterial:1175}];
test('displayed side names describe the pieces: the rules side red is pink, white is ink',()=>{
 assert.equal(sideName('red'),'Pink');assert.equal(sideName('white'),'Ink');
});
test('human playing the pink side (red): You is the first, solid series; Jev the dashed opponent series',()=>{
 const [you,jev]=mobilitySeries(points,'red','jev');
 assert.deepEqual(you,{name:'You (Pink)',values:[7,8,5],opponent:false});
 assert.deepEqual(jev,{name:'Jev (Ink)',values:[7,6,9],opponent:true});
});
test('human playing the ink side (white, every other ranked match): You still solid, Jev still dashed',()=>{
 const [you,jev]=mobilitySeries(points,'white','jev');
 assert.deepEqual(you,{name:'You (Ink)',values:[7,6,9],opponent:false});
 assert.deepEqual(jev,{name:'Jev (Pink)',values:[7,8,5],opponent:true});
});
test('material is drawn from the human side: positive always means you are ahead',()=>{
 assert.deepEqual(materialSeries(points,'red','jev'),[{name:'You − Jev',values:[0,100,-175],opponent:false}]);
 assert.deepEqual(materialSeries(points,'white','jev'),[{name:'You − Jev',values:[0,-100,175],opponent:false}]);
});
test('local practice is never labelled Jev',()=>{
 assert.equal(opponentName('local'),'Local opponent');
 assert.equal(mobilitySeries(points,'red','local')[1].name,'Local opponent (Ink)');
 assert.equal(materialSeries(points,'red','local')[0].name,'You − Local opponent');
});
