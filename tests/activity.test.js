import test from 'node:test';import assert from 'node:assert/strict';
import { testEnv } from './helpers.js';
import worker from '../server/worker.js';
import { ACTIVITY_FRAME_ANCESTORS } from '../server/util.js';
const APP='123456789012345678',ACTIVITY=`https://${APP}.discordsays.com`,BASE='http://127.0.0.1:8787';
function discordFetch(calls=[]){
  return async(url,options)=>{
    calls.push({url:String(url),body:options?.body?String(options.body):null});
    if(String(url).endsWith('/oauth2/token'))return new Response(JSON.stringify({access_token:'fixture-access'}),{headers:{'content-type':'application/json'}});
    if(String(url).endsWith('/users/@me'))return new Response(JSON.stringify({id:'223344556677889900',username:'player',global_name:'Player One',avatar:null}),{headers:{'content-type':'application/json'}});
    throw new Error(`unexpected fetch ${url}`);
  };
}
async function setup(extra={}){return testEnv({DISCORD_APPLICATION_ID:APP,DISCORD_CLIENT_SECRET:'fixture-secret',...extra});}
const send=(t,path,{method='GET',origin,body,headers={}}={})=>worker.fetch(new Request(BASE+path,{method,headers:{...(origin?{origin}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),t.env,t.ctx);
const activitySession=async t=>(await send(t,'/api/activity/session',{method:'POST',origin:ACTIVITY,body:{code:'sdk-code'}})).json();

test('activity config exposes only the public client id and needs Discord configured',async()=>{
  const t=await setup(),r=await send(t,'/api/activity/config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{clientId:APP});t.DB.close();
  const bare=await testEnv();assert.equal((await send(bare,'/api/activity/config')).status,503);bare.DB.close();
});
test('an SDK code becomes a bearer session: exchanged without a redirect uri, token is not stored in clear',async()=>{
  const calls=[],t=await setup({FETCH:discordFetch(calls)}),r=await send(t,'/api/activity/session',{method:'POST',origin:ACTIVITY,body:{code:'sdk-code'}});assert.equal(r.status,200);
  const s=await r.json();assert.match(s.token,/^[a-f0-9]{64}$/);assert.match(s.csrf,/^[a-f0-9]{64}$/);assert.equal(s.accessToken,'fixture-access');assert.equal(s.user.displayName,'Player One');
  const exchange=new URLSearchParams(calls[0].body);assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('code'),'sdk-code');assert.equal(exchange.has('redirect_uri'),false);
  assert.equal(r.headers.get('set-cookie'),null,'no cookie is set inside an Activity');
  assert.equal(t.DB.db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(s.token),undefined,'the raw token must not be stored');
  assert.equal(t.DB.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id IS NOT NULL').get().n,1);
  t.DB.close();
});
test('the bearer session works for reads and for mutations from the activity origin',async()=>{
  const t=await setup({FETCH:discordFetch()}),s=await activitySession(t),auth={authorization:`Bearer ${s.token}`};
  const me=await (await send(t,'/api/me',{headers:auth})).json();assert.equal(me.user.displayName,'Player One');assert.equal(me.csrf,s.csrf);
  assert.equal((await send(t,'/api/analytics/me',{headers:auth})).status,200);
  assert.equal((await send(t,'/api/logout',{method:'POST',origin:ACTIVITY,body:{},headers:{...auth,'x-csrf-token':s.csrf}})).status,200);
  assert.equal((await (await send(t,'/api/me',{headers:auth})).json()).user,null,'logout removed the session');
  t.DB.close();
});
test('the activity origin is accepted only together with a bearer session',async()=>{
  const t=await setup({FETCH:discordFetch()}),s=await activitySession(t),auth={authorization:`Bearer ${s.token}`};
  const first=await send(t,'/api/me'),cookie=first.headers.get('set-cookie').split(';')[0],me=await first.json();
  assert.equal((await send(t,'/api/logout',{method:'POST',origin:ACTIVITY,body:{},headers:{cookie,'x-csrf-token':me.csrf}})).status,403,'a cookie session must not be usable from the discordsays origin');
  assert.equal((await send(t,'/api/logout',{method:'POST',origin:'https://evil.example',body:{},headers:{...auth,'x-csrf-token':s.csrf}})).status,403);
  assert.equal((await send(t,'/api/logout',{method:'POST',origin:'https://999999999999999999.discordsays.com',body:{},headers:{...auth,'x-csrf-token':s.csrf}})).status,403,"another application's discordsays origin is not ours");
  assert.equal((await send(t,'/api/logout',{method:'POST',origin:ACTIVITY,body:{},headers:auth})).status,403,'missing csrf');
  assert.equal((await send(t,'/api/logout',{method:'POST',origin:ACTIVITY,body:{},headers:{...auth,'x-csrf-token':'wrong'}})).status,403);
  t.DB.close();
});
test('session creation rejects foreign origins, missing codes, malformed bearer tokens and Discord failures',async()=>{
  const t=await setup({FETCH:discordFetch()}),post=(origin,body)=>send(t,'/api/activity/session',{method:'POST',origin,body});
  assert.equal((await post('https://evil.example',{code:'c'})).status,403);
  assert.equal((await post(undefined,{code:'c'})).status,403);
  assert.equal((await post(ACTIVITY,{})).status,400);
  assert.equal((await post(ACTIVITY,{code:'x'.repeat(3000)})).status,400);
  assert.equal((await send(t,'/api/me',{headers:{authorization:'Bearer nothex'}})).status,200,'a malformed bearer is ignored and a fresh anonymous session starts');
  assert.equal((await send(t,'/api/analytics/me',{headers:{authorization:`Bearer ${'a'.repeat(64)}`}})).status,401,'an unknown bearer is not a session');
  t.DB.close();
  const failing=await setup({FETCH:async()=>new Response('no',{status:400})});
  assert.equal((await send(failing,'/api/activity/session',{method:'POST',origin:ACTIVITY,body:{code:'c'}})).status,502);failing.DB.close();
});
test('only a page loaded with frame_id may be framed, and only by Discord',async()=>{
  const t=await setup(),plain=await send(t,'/'),framed=await send(t,'/?frame_id=1&instance_id=2&platform=desktop');
  assert.match(plain.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(framed.headers.get('x-frame-options'),null);const csp=framed.headers.get('content-security-policy');
  assert.ok(csp.includes(ACTIVITY_FRAME_ANCESTORS));assert.ok(!csp.includes("frame-ancestors 'none'"));
  assert.match(csp,/script-src 'self'/,'the rest of the policy is unchanged');assert.match(csp,/connect-src 'self'/);
  const api=await send(t,'/api/me?frame_id=1');assert.match(api.headers.get('content-security-policy'),/frame-ancestors 'none'/,'API responses are never frameable');
  t.DB.close();
});
