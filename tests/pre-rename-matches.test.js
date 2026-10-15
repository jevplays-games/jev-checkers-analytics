// Matches stored IN PROGRESS by the pre-rename build (origin/main 588c07b: gameId 'checkers', old service name) must
// still finish, resign and expire on this build without a 5xx. The rows in fixtures/pre-rename-matches.json were
// written by that build's own server code (fixtures/gen-pre-rename-matches.mjs); only their clocks are moved to now.
import test from 'node:test';import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../server/worker.js';
import { maintenance } from '../server/matches.js';
import { verifyReplay } from '../public/lib/audit.js';
import { testEnv,mockJev } from './helpers.js';

const fixture=JSON.parse(await readFile(new URL('./fixtures/pre-rename-matches.json',import.meta.url),'utf8'));
const DAY=86400000;
async function restore(){
  const t=await testEnv({TYPESAFE_API_KEY:'test',FETCH:async(_u,init)=>new Response(JSON.stringify(mockJev(JSON.parse(init.body))))});
  for(const [table,rows] of Object.entries(fixture.tables))for(const row of rows){const cols=Object.keys(row);
    t.DB.db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));}
  const now=Date.now();
  t.DB.db.prepare('UPDATE sessions SET expires_at=?').run(now+DAY);
  t.DB.db.prepare("UPDATE matches SET human_deadline=? WHERE status='human_turn'").run(now+DAY);
  return t;
}
function as(t,cookie){let csrf='';return async(path,{method='GET',body}={})=>{
  const r=await worker.fetch(new Request(`http://127.0.0.1:8787${path}`,{method,headers:{cookie,...(method==='POST'?{'content-type':'application/json','x-csrf-token':csrf,origin:'http://127.0.0.1:8787'}:{})},...(body?{body:JSON.stringify(body)}:{})}),t.env,t.ctx);
  await t.drain();const data=await r.json().catch(()=>null);if(data?.csrf)csrf=data.csrf;
  assert(r.status<500,`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);return {status:r.status,data};};}
async function replayOf(request,id){const r=await request(`/api/matches/${id}/replay`);assert.equal(r.status,200);
  assert.equal(r.data.manifest.gameId,'checkers');assert((await verifyReplay(r.data)).valid);return r.data;}

test('fixture really is pre-rename and in progress',()=>{
  assert.equal(fixture.build,'588c07b');
  assert(fixture.tables.matches.every(m=>JSON.parse(m.manifest_json).gameId==='checkers'));
  assert.deepEqual(Object.fromEntries(Object.entries(fixture.status).map(([k,v])=>[k,v.status])),{finish:'human_turn',resign:'human_turn',expire:'human_turn',pending:'jev_pending'});
});
test('a pre-rename casual match can be played to the end',async()=>{
  const t=await restore(),request=as(t,fixture.cookies.finish),id=fixture.matches.finish;await request('/api/me');
  let s=(await request(`/api/matches/${id}`)).data;
  for(let i=0;i<400&&s.status!=='complete';i++){
    if(s.status==='human_turn')s=(await request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:s.revision,requestId:crypto.randomUUID(),actionId:s.legalActions[0].id}})).data;
    else{await request(`/api/matches/${id}/advance`,{method:'POST',body:{}});s=(await request(`/api/matches/${id}`)).data;}
  }
  assert.equal(s.status,'complete');assert(s.outcome?.reason);
  const replay=await replayOf(request,id);assert.equal(replay.format,'jev-typecheckers-audit');
  assert(replay.events.length>fixture.status.finish.revision+10,'the game was really played on, not just closed');t.DB.close();
});
test('a pre-rename casual match can be resigned',async()=>{
  const t=await restore(),request=as(t,fixture.cookies.resign),id=fixture.matches.resign;await request('/api/me');
  const s=(await request(`/api/matches/${id}`)).data;
  const r=await request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:s.revision,requestId:crypto.randomUUID(),resign:true}});
  assert.equal(r.status,200);assert.equal(r.data.status,'complete');assert.equal(r.data.outcome.reason,'resign');
  await replayOf(request,id);t.DB.close();
});
test('a pre-rename ranked match past its deadline is expired by maintenance and still ranks',async()=>{
  const t=await restore(),request=as(t,fixture.cookies.expire),id=fixture.matches.expire;await request('/api/me');
  t.DB.db.prepare('UPDATE matches SET human_deadline=? WHERE id=?').run(Date.now()-1,id);
  await maintenance(t.env);
  const s=(await request(`/api/matches/${id}`)).data;assert.equal(s.status,'complete');assert.equal(s.outcome.reason,'abandoned');
  await replayOf(request,id);
  assert.equal((await request('/api/leaderboard?scope=world&difficulty=easy')).status,200);
  assert.equal((await request('/api/analytics/me')).status,200);t.DB.close();
});
test('a pre-rename ranked match left waiting for Jev is advanced, then resigned',async()=>{
  const t=await restore(),request=as(t,fixture.cookies.pending),id=fixture.matches.pending;await request('/api/me');
  await maintenance(t.env);
  let s=(await request(`/api/matches/${id}`)).data;assert.equal(s.status,'human_turn');
  s=(await request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:s.revision,requestId:crypto.randomUUID(),resign:true}})).data;
  assert.equal(s.status,'complete');await replayOf(request,id);t.DB.close();
});
