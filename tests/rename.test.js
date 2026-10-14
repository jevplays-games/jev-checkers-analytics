// Checkers -> Typecheckers. New records, links and commands use the new names; everything issued before
// the rename (replays, gameIds, the /play checkers command, the old hostname and return path) keeps working.
import test from 'node:test';import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyReplay,GAME_ID,REPLAY_FORMAT,isGameId,isReplayFormat } from '../public/lib/audit.js';
import worker from '../server/worker.js';
import { client,testEnv } from './helpers.js';

const NEW='https://typecheckers.jevplay.games',OLD='https://checkers.jevplay.games';
const exampleReplay=async()=>JSON.parse(await readFile(new URL('../reports/example-replay.json',import.meta.url),'utf8'));

test('a replay exported before the rename (reports/example-replay.json) still verifies',async()=>{
 const r=await exampleReplay();assert.equal(r.format,'jev-checkers-audit');assert.equal(r.manifest.gameId,'checkers');
 const v=await verifyReplay(r);assert(v.valid);assert.equal(v.eventCount,r.events.length);
});
test('the same record verifies under the new format name; an unknown format is rejected',async()=>{
 const r=await exampleReplay();r.format=REPLAY_FORMAT;assert((await verifyReplay(r)).valid);
 r.format='jev-chess-audit';await assert.rejects(()=>verifyReplay(r),/Unsupported replay/);
});
test('ids: new values are emitted, old values accepted',()=>{
 assert.equal(GAME_ID,'typecheckers');assert.equal(REPLAY_FORMAT,'jev-typecheckers-audit');
 assert(isGameId('typecheckers')&&isGameId('checkers')&&!isGameId('tic-tac-toe'));
 assert(isReplayFormat('jev-typecheckers-audit')&&isReplayFormat('jev-checkers-audit')&&!isReplayFormat('jev-arcade-replay'));
});
test('new matches record gameId typecheckers and export the new replay format',async()=>{
 const t=await testEnv(),c=await client(t);await c.request('/api/me');
 const start=await c.request('/api/matches',{method:'POST',body:{gameId:'typecheckers',opponent:'local',mode:'casual',difficulty:'easy',requestId:crypto.randomUUID()}});assert.equal(start.status,201);
 const replay=await c.request(`/api/matches/${start.data.id}/replay`);assert.equal(replay.data.format,'jev-typecheckers-audit');assert.equal(replay.data.manifest.gameId,'typecheckers');
 assert((await verifyReplay(replay.data)).valid);t.DB.close();
});
test('a client still sending the legacy gameId checkers can start a match; other ids are refused',async()=>{
 const t=await testEnv(),c=await client(t);await c.request('/api/me');
 const body=gameId=>({gameId,opponent:'local',mode:'casual',difficulty:'easy',requestId:crypto.randomUUID()});
 assert.equal((await c.request('/api/matches',{method:'POST',body:body('tic-tac-toe')})).status,400);
 assert.equal((await c.request('/api/matches',{method:'POST',body:body('checkers')})).status,201);t.DB.close();
});
test('health reports the new service name',async()=>{const t=await testEnv(),c=await client(t);assert.equal((await c.request('/api/health')).data.service,'jev-typecheckers');t.DB.close();});

// Discord: /play typecheckers is registered; /play checkers stays accepted until it is deregistered.
const hex=b=>Buffer.from(b).toString('hex');
async function discord(){
 const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']),publicKey=hex(await crypto.subtle.exportKey('raw',keys.publicKey));
 const t=await testEnv({DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'1111111111'}),c=await client(t);
 const send=async name=>{const data={id:crypto.randomUUID(),type:2,application_id:'1111111111',context:0,guild_id:'2222222222',channel_id:'3333333333',channel:{id:'3333333333',type:0},member:{user:{id:'4444444444'}},authorizing_integration_owners:{'0':'2222222222'},data:{name:'play',options:[{type:1,name}]}};
  const raw=JSON.stringify(data),timestamp=String(Math.floor(Date.now()/1000)),sig=hex(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+raw)));
  return c.request('/api/discord/interactions',{method:'POST',raw,headers:{'x-signature-ed25519':sig,'x-signature-timestamp':timestamp}});};
 return {t,send};
}
for(const name of ['typecheckers','checkers'])test(`/play ${name} issues a launch link to /play/typecheckers`,async()=>{
 const {t,send}=await discord(),r=await send(name);assert.equal(r.status,200);
 const button=r.data.data.components[0].components[0],url=new URL(button.url);
 assert.equal(url.pathname,'/play/typecheckers');assert.equal(button.label,'Open Typecheckers');assert.match(r.data.data.content,/^Play Typecheckers against Jev\./);
 const grant=JSON.parse(t.DB.db.prepare('SELECT payload_json FROM grants').get().payload_json);assert.equal(grant.gameId,'typecheckers');t.DB.close();
});
test('an unknown /play subcommand is rejected',async()=>{const {t,send}=await discord();assert.equal((await send('chess')).status,400);t.DB.close();});

// Hostnames: one Worker serves the new and the old host until the redirect cutover.
async function hosts(){
 const t=await testEnv({APP_ENV:'production',APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:OLD,DISCORD_APPLICATION_ID:'1111111111',DISCORD_CLIENT_SECRET:'test'});
 const on=host=>{let cookie='',csrf='';return async(path,{method='GET',body,origin=host}={})=>{
  const response=await worker.fetch(new Request(`${host}${path}`,{method,headers:{cookie,...(method==='POST'?{'content-type':'application/json','x-csrf-token':csrf,origin}:{})},...(body?{body:JSON.stringify(body)}:{})}),t.env,t.ctx);
  const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];let data=null;try{data=await response.clone().json();}catch{}if(data?.csrf)csrf=data.csrf;return {response,data,status:response.status};};};
 return {t,on};
}
for(const [host,expected] of [[NEW,NEW],[OLD,OLD],['https://evil.example',NEW]])test(`OAuth on ${host} returns to ${expected}`,async()=>{
 const {t,on}=await hosts(),request=on(host),start=await request('/api/auth/discord?return=/play/typecheckers');assert.equal(start.status,302);
 assert.equal(new URL(start.response.headers.get('location')).searchParams.get('redirect_uri'),`${expected}/api/auth/discord/callback`);t.DB.close();
});
test('both the new and the legacy /play return paths are allowed',async()=>{
 const {t,on}=await hosts(),request=on(NEW);
 for(const path of ['/play/typecheckers','/play/checkers','/'])assert.equal((await request(`/api/auth/discord?return=${path}`)).status,302);
 assert.equal((await request('/api/auth/discord?return=/play/chess')).status,400);t.DB.close();
});
test('a same-host mutation works on either hostname; a cross-host one is refused',async()=>{
 const {t,on}=await hosts(),body=()=>({gameId:'typecheckers',opponent:'local',mode:'casual',difficulty:'easy',requestId:crypto.randomUUID()});
 const old=on(OLD);await old('/api/me');assert.equal((await old('/api/matches',{method:'POST',body:body()})).status,201);
 const fresh=on(NEW);await fresh('/api/me');assert.equal((await fresh('/api/matches',{method:'POST',body:body()})).status,201);
 const cross=on(OLD);await cross('/api/me');assert.equal((await cross('/api/matches',{method:'POST',body:body(),origin:NEW})).status,403);
 t.DB.close();
});

// Browser storage keys move from jev-checkers-* / checkers-launch to the new keys once.
import { migrateStorage,ACTIVE_KEY,HISTORY_KEY,LAUNCH_KEY } from '../public/lib/storage.js';
const memoryStorage=(entries={})=>{const m=new Map(Object.entries(entries));return {m,getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
test('pre-rename storage keys are moved to the jev-typecheckers-* keys',()=>{
 assert.equal(ACTIVE_KEY,'jev-typecheckers-active');assert.equal(HISTORY_KEY,'jev-typecheckers-history');assert.equal(LAUNCH_KEY,'typecheckers-launch');
 const local=memoryStorage({'jev-checkers-active':'{"a":1}','jev-checkers-history':'[1]','jev-analysis-on':'true'}),session=memoryStorage({'checkers-launch':'f'.repeat(64)});
 migrateStorage(local,session);
 assert.deepEqual(Object.fromEntries(local.m),{'jev-typecheckers-active':'{"a":1}','jev-typecheckers-history':'[1]','jev-analysis-on':'true'});
 assert.deepEqual(Object.fromEntries(session.m),{'typecheckers-launch':'f'.repeat(64)});
 migrateStorage(local,session);assert.equal(local.m.size,3);
});
test('storage migration keeps newer data, drops the stale key, and survives blocked storage',()=>{
 const local=memoryStorage({'jev-checkers-history':'[old]','jev-typecheckers-history':'[new]'});migrateStorage(local,null);
 assert.deepEqual(Object.fromEntries(local.m),{'jev-typecheckers-history':'[new]'});
 const blocked={getItem(){throw new Error('SecurityError');},setItem(){throw new Error('SecurityError');},removeItem(){throw new Error('SecurityError');}};
 assert.doesNotThrow(()=>migrateStorage(blocked,blocked));
});

// Orchestrator rule D9: hostile or malformed LEGACY_APP_ORIGINS entries are skipped, never admitted, never a 500.
import { appOrigins } from '../server/util.js';
const HOSTILE=['https://user:pw@evil.example',`https://evil.example#@checkers.jevplay.games`,'https://evil.example/path','https://evil.example?q=1','https://*.jevplay.games','not a url','javascript:alert(1)','http://checkers.jevplay.games'];
test('D9: only bare origins are admitted from LEGACY_APP_ORIGINS',()=>{
 const env={APP_ENV:'production',APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:[...HOSTILE,`${OLD}/`].join(',')};
 const warn=console.warn;let warnings=0;console.warn=()=>warnings++;
 try{assert.deepEqual(appOrigins(env),[NEW,OLD]);}finally{console.warn=warn;}
 assert(warnings<=HOSTILE.length);
});
for(const entry of HOSTILE)test(`D9: legacy entry ${entry} admits no evil host and keeps both real hosts working`,async()=>{
 const warn=console.warn;console.warn=()=>{};
 try{
  const t=await testEnv({APP_ENV:'production',APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:`${entry},${OLD}`,DISCORD_APPLICATION_ID:'1111111111',DISCORD_CLIENT_SECRET:'test'});
  const start=async host=>{const r=await worker.fetch(new Request(`${host}/api/auth/discord`),t.env,t.ctx);assert(r.status<500);return new URL(r.headers.get('location')).searchParams.get('redirect_uri');};
  assert.equal(await start('https://evil.example'),`${NEW}/api/auth/discord/callback`);
  assert.equal(await start(NEW),`${NEW}/api/auth/discord/callback`);
  assert.equal(await start(OLD),`${OLD}/api/auth/discord/callback`);
  const health=await worker.fetch(new Request('https://evil.example/api/health'),t.env,t.ctx);assert.equal(health.status,200);
  t.DB.close();
 }finally{console.warn=warn;}
});
