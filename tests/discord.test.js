import test from 'node:test';import assert from 'node:assert/strict';
import { client,testEnv } from './helpers.js';
const hex=b=>Buffer.from(b).toString('hex');
async function signedEnvironment(){
 const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']),publicKey=hex(await crypto.subtle.exportKey('raw',keys.publicKey));
 const t=await testEnv({DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'1111111111'}),c=await client(t);
 const sign=async(data,timestamp=String(Math.floor(Date.now()/1000)))=>{const raw=JSON.stringify(data),sig=hex(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+raw)));return {raw,headers:{'x-signature-ed25519':sig,'x-signature-timestamp':timestamp}};};
 return {t,c,sign};
}
const command=()=>({id:crypto.randomUUID(),type:2,application_id:'1111111111',context:0,guild_id:'2222222222',channel_id:'3333333333',channel:{id:'3333333333',type:0},member:{user:{id:'4444444444'}},authorizing_integration_owners:{'0':'2222222222'},data:{name:'play',options:[{type:1,name:'checkers'}]}});
test('signed Discord PING succeeds; unsigned PING is rejected',async()=>{const {t,c,sign}=await signedEnvironment();const body={type:1,application_id:'1111111111'};assert.equal((await c.request('/api/discord/interactions',{method:'POST',...await sign(body)})).data.type,1);assert.equal((await c.request('/api/discord/interactions',{method:'POST',body})).status,401);t.DB.close();});
test('signature rejects tampered body and stale timestamp',async()=>{const {t,c,sign}=await signedEnvironment();const s=await sign(command());s.raw+=' ';assert.equal((await c.request('/api/discord/interactions',{method:'POST',...s})).status,401);assert.equal((await c.request('/api/discord/interactions',{method:'POST',...await sign(command(),'1000000000')})).status,401);t.DB.close();});
test('guild command creates user-bound opaque launch without raw identities in URL',async()=>{const {t,c,sign}=await signedEnvironment(),r=await c.request('/api/discord/interactions',{method:'POST',...await sign(command())});assert.equal(r.status,200);const url=r.data.data.components[0].components[0].url;assert(/launch=[a-f0-9]{64}$/.test(url));assert(!url.includes('4444444444'));t.DB.close();});
test('DM, user-install, unsupported channel and wrong application are rejected',async()=>{const {t,c,sign}=await signedEnvironment();for(const change of [x=>x.context=1,x=>x.authorizing_integration_owners={},x=>x.channel.type=11,x=>x.application_id='9999999999']){const cmd=command();change(cmd);assert((await c.request('/api/discord/interactions',{method:'POST',...await sign(cmd)})).status>=400);}t.DB.close();});
test('launch grant is account-bound, single-use and retains only a short-lived context',async()=>{
 const {t,c,sign}=await signedEnvironment();await c.request('/api/me');const r=await c.request('/api/discord/interactions',{method:'POST',...await sign(command())});const token=new URL(r.data.data.components[0].components[0].url).searchParams.get('launch');
 const time=Date.now();t.DB.db.prepare('INSERT INTO users(id,discord_id,display_name,created_at,last_seen) VALUES (?,?,?,?,?)').run('u','4444444444','Player',time,time);t.DB.db.prepare('UPDATE sessions SET user_id=?').run('u');
 const redeemed=await c.request('/api/launch/redeem',{method:'POST',body:{token}});assert.equal(redeemed.status,200);const me=await c.request('/api/me');assert.equal(me.data.context.guildId,'2222222222');assert(me.data.context.matchAvailable);assert(me.data.context.expiresAt<=time+901000);
 assert.equal((await c.request('/api/launch/redeem',{method:'POST',body:{token}})).status,403);t.DB.close();
});
test('forwarded launch cannot be redeemed by a different Discord user',async()=>{const {t,c,sign}=await signedEnvironment();await c.request('/api/me');const r=await c.request('/api/discord/interactions',{method:'POST',...await sign(command())});const token=new URL(r.data.data.components[0].components[0].url).searchParams.get('launch');const time=Date.now();t.DB.db.prepare('INSERT INTO users(id,discord_id,display_name,created_at,last_seen) VALUES (?,?,?,?,?)').run('u','5555555555','Other',time,time);t.DB.db.prepare('UPDATE sessions SET user_id=?').run('u');assert.equal((await c.request('/api/launch/redeem',{method:'POST',body:{token}})).status,403);t.DB.close();});
test('OAuth state validates, rotates session, retrieves identity and never stores provider tokens',async()=>{
 let access='sensitive-test-access',secret='sensitive-client-secret';
 const t=await testEnv({DISCORD_APPLICATION_ID:'1111111111',DISCORD_CLIENT_SECRET:secret,FETCH:async(url)=>url.endsWith('/users/@me')?new Response(JSON.stringify({id:'4444444444',username:'tester',global_name:'Tester'})):url.endsWith('/revoke')?new Response('{}'):new Response(JSON.stringify({access_token:access}))}),c=await client(t);
 await c.request('/api/me');const old=c.cookie,start=await c.request('/api/auth/discord');assert.equal(start.status,302);const url=new URL(start.response.headers.get('location'));assert.equal(url.searchParams.get('scope'),'identify');const state=url.searchParams.get('state');
 const callback=await c.request(`/api/auth/discord/callback?code=code&state=${state}`);assert.equal(callback.status,302);assert.notEqual(c.cookie,old);
 const me=await c.request('/api/me');assert.equal(me.data.user.displayName,'Tester');
 assert.equal((await c.request(`/api/auth/discord/callback?code=code&state=${state}`)).status,400);
 const dump=JSON.stringify(t.DB.db.prepare('SELECT * FROM operations').all());assert(!dump.includes(access));assert(!dump.includes(secret));t.DB.close();
});
test('OAuth callback rejects wrong browser session and unapproved return path',async()=>{const t=await testEnv({DISCORD_APPLICATION_ID:'1111111111',DISCORD_CLIENT_SECRET:'test'}),c=await client(t),other=await client(t);await c.request('/api/me');await other.request('/api/me');assert.equal((await c.request('/api/auth/discord?return=https://evil.example')).status,400);const start=await c.request('/api/auth/discord'),state=new URL(start.response.headers.get('location')).searchParams.get('state');assert.equal((await other.request(`/api/auth/discord/callback?code=c&state=${state}`)).status,400);t.DB.close();});
test('redeemed context is consumed by one ranked match and scopes its verified result',async()=>{
 const {t,c,sign}=await signedEnvironment();t.env.TYPESAFE_API_KEY='test-key';await c.request('/api/me');
 const at=Date.now();t.DB.db.prepare('INSERT INTO users(id,discord_id,display_name,created_at,last_seen) VALUES (?,?,?,?,?)').run('u','4444444444','Player',at,at);t.DB.db.prepare('UPDATE sessions SET user_id=?').run('u');
 const launch=await c.request('/api/discord/interactions',{method:'POST',...await sign(command())});
 const token=new URL(launch.data.data.components[0].components[0].url).searchParams.get('launch');assert.equal((await c.request('/api/launch/redeem',{method:'POST',body:{token}})).status,200);
 const start=await c.request('/api/matches',{method:'POST',body:{gameId:'checkers',mode:'ranked',opponent:'jev',difficulty:'easy',requestId:crypto.randomUUID()}});assert.equal(start.status,201);
 const stored=t.DB.db.prepare('SELECT guild_id,channel_id FROM matches WHERE id=?').get(start.data.id);assert.equal(stored.guild_id,'2222222222');assert.equal(stored.channel_id,'3333333333');
 assert.equal((await c.request('/api/me')).data.context.matchAvailable,false);
 const end=await c.request(`/api/matches/${start.data.id}/actions`,{method:'POST',body:{expectedRevision:0,requestId:crypto.randomUUID(),resign:true}});assert.equal(end.data.eligible,true);
 for(const scope of ['world','server','channel'])assert.equal((await c.request(`/api/leaderboard?scope=${scope}&difficulty=easy`)).data.entries.length,1);
 t.DB.db.prepare('UPDATE sessions SET context_json=?').run(JSON.stringify({guildId:'9999999999',channelId:'8888888888',expiresAt:Date.now()+10000}));
 for(const scope of ['server','channel'])assert.equal((await c.request(`/api/leaderboard?scope=${scope}&difficulty=easy`)).data.entries.length,0);
 assert.equal((await c.request('/api/leaderboard?scope=world&difficulty=easy')).data.entries.length,1);t.DB.close();
});
