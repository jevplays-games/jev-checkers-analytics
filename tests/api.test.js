import test from 'node:test';import assert from 'node:assert/strict';
import { client,testEnv,mockJev } from './helpers.js';
import { verifyReplay } from '../public/lib/audit.js';
import { maintenance } from '../server/matches.js';
const newBody=(extra={})=>({gameId:'checkers',opponent:'local',mode:'casual',difficulty:'easy',requestId:crypto.randomUUID(),...extra});
async function setup(extra={}){const t=await testEnv(extra),c=await client(t);await c.request('/api/me');return {t,c};}
async function fakeLogin(t){const time=Date.now();t.DB.db.prepare('INSERT INTO users(id,discord_id,display_name,created_at,last_seen) VALUES (?,?,?,?,?)').run('user1','1234567890','Test player',time,time);t.DB.db.prepare('UPDATE sessions SET user_id=?').run('user1');}
test('guest session is opaque and cookie is HttpOnly; capability state is honest',async()=>{const {t,c}=await setup();const r=await c.request('/api/me');assert.equal(r.data.capabilities.jev,false);assert.equal(r.data.user,null);assert(r.data.csrf);assert(c.cookie.startsWith('jev_dev_session='));t.DB.close();});
test('missing or wrong CSRF and cross-origin writes are rejected',async()=>{const {t,c}=await setup();for(const headers of [{'x-csrf-token':''},{'x-csrf-token':'wrong'}])assert.equal((await c.request('/api/matches',{method:'POST',body:newBody(),headers})).status,403);assert.equal((await c.request('/api/matches',{method:'POST',body:newBody(),origin:'https://evil.example'})).status,403);t.DB.close();});
test('unknown score, board and guild fields are rejected',async()=>{const {t,c}=await setup();for(const extra of [{score:999},{guildId:'fake'},{board:[]}])assert.equal((await c.request('/api/matches',{method:'POST',body:newBody(extra)})).status,400);t.DB.close();});
test('ranked local opponent and unconfigured JEV cannot be started',async()=>{const {t,c}=await setup();assert.equal((await c.request('/api/matches',{method:'POST',body:newBody({mode:'ranked'})})).status,403);assert.equal((await c.request('/api/matches',{method:'POST',body:newBody({opponent:'jev'})})).status,503);t.DB.close();});
test('idempotent creation returns same match; changed payload with same ID fails',async()=>{const {t,c}=await setup(),body=newBody(),first=await c.request('/api/matches',{method:'POST',body}),second=await c.request('/api/matches',{method:'POST',body});assert.equal(first.status,201);assert.equal(second.data.id,first.data.id);assert.equal((await c.request('/api/matches',{method:'POST',body:{...body,difficulty:'hard'}})).status,409);t.DB.close();});
test('authoritative human/local-opponent turns, resignation, replay and analytics work end to end',async()=>{
 const {t,c}=await setup(),start=await c.request('/api/matches',{method:'POST',body:newBody()}),id=start.data.id;
 const body={expectedRevision:0,requestId:crypto.randomUUID(),actionId:'m:09-13'},move=await c.request(`/api/matches/${id}/actions`,{method:'POST',body});assert.equal(move.status,200);assert.equal(move.data.revision,1);
 await t.drain();const snap=await c.request(`/api/matches/${id}`);assert.equal(snap.data.revision,2);assert.equal(snap.data.status,'human_turn');
 const duplicate=await c.request(`/api/matches/${id}/actions`,{method:'POST',body});assert.equal(duplicate.status,200);assert.equal(duplicate.data.revision,2);
 const resigned=await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:2,requestId:crypto.randomUUID(),resign:true}});assert.equal(resigned.data.status,'complete');assert.equal(resigned.data.verification,'verified');assert.equal(resigned.data.eligible,false);
 const replay=await c.request(`/api/matches/${id}/replay`);assert((await verifyReplay(replay.data)).valid);
 const metrics=await c.request(`/api/matches/${id}/analytics`);assert.equal(metrics.data.turns,2);assert.equal(metrics.data.sourceCounts.local,1);
 assert.equal((await c.request(`/api/matches/${id}/analytics?format=moves.csv`)).status,200);t.DB.close();
});
test('another session cannot read or mutate owned matches',async()=>{const {t,c}=await setup(),id=(await c.request('/api/matches',{method:'POST',body:newBody()})).data.id,other=await client(t);await other.request('/api/me');for(const suffix of ['', '/replay','/analytics','/operations'])assert.equal((await other.request(`/api/matches/${id}${suffix}`)).status,404);t.DB.close();});
test('illegal actions and stale revisions never mutate state',async()=>{const {t,c}=await setup(),id=(await c.request('/api/matches',{method:'POST',body:newBody()})).data.id;assert.equal((await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:0,requestId:crypto.randomUUID(),actionId:'m:01-32'}})).status,422);assert.equal((await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:99,requestId:crypto.randomUUID(),actionId:'m:09-13'}})).status,409);assert.equal((await c.request(`/api/matches/${id}`)).data.revision,0);t.DB.close();});
test('competing actions commit exactly one human turn',async()=>{const {t,c}=await setup(),id=(await c.request('/api/matches',{method:'POST',body:newBody()})).data.id;
 const responses=await Promise.all(['m:09-13','m:09-14'].map(actionId=>c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:0,requestId:crypto.randomUUID(),actionId}})));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);await t.drain();assert.equal(t.DB.db.prepare("SELECT COUNT(*) AS n FROM events WHERE match_id=? AND kind='move'").get(id).n,2);t.DB.close();});
test('JEV provider outage becomes a verified no-contest, not a loss or silent fallback',async()=>{
 const {t,c}=await setup({TYPESAFE_API_KEY:'test',FETCH:async()=>new Response('{}',{status:401})});await fakeLogin(t);
 const id=(await c.request('/api/matches',{method:'POST',body:newBody({opponent:'jev',mode:'ranked'})})).data.id;
 await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:0,requestId:crypto.randomUUID(),actionId:'m:09-13'}});await t.drain();
 const snap=(await c.request(`/api/matches/${id}`)).data;assert.equal(snap.status,'void');assert.equal(snap.eligible,false);assert.equal(snap.outcome.reason,'service_failure');assert.equal(snap.verification,'verified');
 assert.equal(t.DB.db.prepare('SELECT result_units FROM matches WHERE id=?').get(id).result_units,null);t.DB.close();
});
test('mocked real-provider contract produces a verified ranked result and a provisional world entry',async()=>{
 const {t,c}=await setup({TYPESAFE_API_KEY:'test',FETCH:async(_u,i)=>new Response(JSON.stringify(mockJev(JSON.parse(i.body))))});await fakeLogin(t);
 const id=(await c.request('/api/matches',{method:'POST',body:newBody({opponent:'jev',mode:'ranked'})})).data.id;
 await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:0,requestId:crypto.randomUUID(),actionId:'m:09-13'}});await t.drain();
 const resigned=await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:2,requestId:crypto.randomUUID(),resign:true}});
 assert.equal(resigned.data.status,'complete');assert.equal(resigned.data.eligible,true);
 const board=await c.request('/api/leaderboard?scope=world&difficulty=easy');assert.equal(board.data.entries.length,1);assert(board.data.entries[0].provisional);assert.equal(board.data.entries[0].losses,1);
 assert.equal((await c.request('/api/leaderboard?scope=channel&difficulty=easy')).status,403);t.DB.close();
});
test('abandoned human turn is a server-recorded administrative loss',async()=>{const {t,c}=await setup(),id=(await c.request('/api/matches',{method:'POST',body:newBody()})).data.id;t.DB.db.prepare('UPDATE matches SET human_deadline=? WHERE id=?').run(Date.now()-1,id);await maintenance(t.env);const m=(await c.request(`/api/matches/${id}`)).data;assert.equal(m.status,'complete');assert.equal(m.outcome.reason,'abandoned');t.DB.close();});
test('browser telemetry requires consent and cannot submit arbitrary payloads',async()=>{const {t,c}=await setup(),id=(await c.request('/api/matches',{method:'POST',body:newBody()})).data.id;
 assert.equal((await c.request('/api/telemetry',{method:'POST',body:{matchId:id,consent:false,events:[]}})).status,400);
 assert.equal((await c.request('/api/telemetry',{method:'POST',body:{matchId:id,consent:true,events:[{kind:'keystroke',elapsedMs:1}]}})).status,400);
 const ok=await c.request('/api/telemetry',{method:'POST',body:{matchId:id,consent:true,events:[{kind:'board_render',elapsedMs:3,secret:'not retained'}]}});assert.equal(ok.data.trust,'untrusted_client');
 const op=t.DB.db.prepare("SELECT payload_json FROM operations WHERE kind='browser_telemetry'").get();assert(!op.payload_json.includes('secret'));t.DB.close();});
test('admin analytics require a distinct bearer credential',async()=>{const {t,c}=await setup({ANALYTICS_ADMIN_TOKEN:'operator-test-token'});assert.equal((await c.request('/api/analytics/admin')).status,403);assert.equal((await c.request('/api/analytics/admin',{headers:{authorization:'Bearer operator-test-token'}})).status,200);t.DB.close();});
test('content security policy and no-store protect API responses',async()=>{const {t,c}=await setup(),r=await c.request('/api/me');assert(r.response.headers.get('content-security-policy').includes("script-src 'self'"));assert.equal(r.response.headers.get('cache-control'),'no-store');assert.equal(r.response.headers.get('referrer-policy'),'no-referrer');t.DB.close();});
test('expired lease discards late JEV result without a second move',async()=>{
 let calls=0,resolveFirst;const {t,c}=await setup({TYPESAFE_API_KEY:'test',FETCH:async(_url,init)=>{
   const response=new Response(JSON.stringify(mockJev(JSON.parse(init.body))));
   if(++calls===1)return new Promise(resolve=>{resolveFirst=()=>resolve(response);});return response;
 }});
 const id=(await c.request('/api/matches',{method:'POST',body:newBody({opponent:'jev'})})).data.id;
 await c.request(`/api/matches/${id}/actions`,{method:'POST',body:{expectedRevision:0,requestId:crypto.randomUUID(),actionId:'m:09-13'}});
 while(!resolveFirst)await new Promise(resolve=>setTimeout(resolve,1));
 t.DB.db.prepare('UPDATE matches SET lease_until=? WHERE id=?').run(Date.now()-1,id);
 const {advanceMatch}=await import('../server/matches.js');await advanceMatch(id,t.env);resolveFirst();await t.drain();
 assert.equal((await c.request(`/api/matches/${id}`)).data.revision,2);
 assert.equal(t.DB.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='stale_decision_discarded'").get().n,1);t.DB.close();
});
