// Run the PRE-RENAME build (origin/main 588c07b, exported to ./old) and leave matches IN PROGRESS, then dump every row.
import { readFile,writeFile } from 'node:fs/promises';
// Usage: git archive 588c07b | tar -x -C <dir>; node tests/fixtures/gen-pre-rename-matches.mjs <dir> tests/fixtures/pre-rename-matches.json
const OLD=new URL(`file://${process.argv[2].replace(/\/?$/,'/')}`);
const { NodeDB }=await import(new URL('server/node-db.js',OLD));
const worker=(await import(new URL('server/worker.js',OLD))).default;
const { mockJev }=await import(new URL('tests/helpers.js',OLD));
const DB=new NodeDB();DB.exec(await readFile(new URL('migrations/001.sql',OLD),'utf8'));
const tasks=[],ctx={waitUntil(p){tasks.push(p);}},drain=async()=>{while(tasks.length)await tasks.shift();};
const env={DB,APP_ENV:'local',APP_ORIGIN:'http://127.0.0.1:8787',ASSETS:{fetch:()=>new Response('static')},TYPESAFE_API_KEY:'test',
  FETCH:async(_u,init)=>new Response(JSON.stringify(mockJev(JSON.parse(init.body))))};
function client(){let cookie='',csrf='';return {get cookie(){return cookie;},async request(path,{method='GET',body}={}){
  const r=await worker.fetch(new Request(`http://127.0.0.1:8787${path}`,{method,headers:{cookie,...(method==='POST'?{'content-type':'application/json','x-csrf-token':csrf,origin:'http://127.0.0.1:8787'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);
  const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await r.json().catch(()=>null);if(data?.csrf)csrf=data.csrf;
  if(r.status>=500)throw new Error(`${path} ${r.status}`);return {status:r.status,data};}};}
async function login(c,user){await c.request('/api/me');const t=Date.now();DB.db.prepare('INSERT INTO users(id,discord_id,display_name,created_at,last_seen) VALUES (?,?,?,?,?)').run(user,String(1000000000+DB.db.prepare('SELECT COUNT(*) n FROM users').get().n),user,t,t);
  DB.db.prepare('UPDATE sessions SET user_id=? WHERE user_id IS NULL').run(user);}
const out={build:'588c07b',cookies:{},matches:{}};
const start=async(c,opponent,mode)=>(await c.request('/api/matches',{method:'POST',body:{gameId:'checkers',opponent,mode,difficulty:'easy',requestId:crypto.randomUUID()}})).data;
const move=async(c,m)=>{const s=(await c.request(`/api/matches/${m.id}`)).data;return (await c.request(`/api/matches/${m.id}/actions`,{method:'POST',body:{expectedRevision:s.revision,requestId:crypto.randomUUID(),actionId:s.legalActions[0].id}})).data;};
// finish: casual vs server-local opponent, one full exchange played
{const c=client();await c.request('/api/me');const m=await start(c,'local','casual');await drain();await move(c,m);await drain();out.cookies.finish=c.cookie;out.matches.finish=m.id;}
// resign: casual, no moves yet
{const c=client();await c.request('/api/me');const m=await start(c,'local','casual');await drain();out.cookies.resign=c.cookie;out.matches.resign=m.id;}
// expire: ranked vs Jev (signed in), one exchange played, waiting for the human
{const c=client();await login(c,'expire-user');const m=await start(c,'jev','ranked');await drain();await move(c,m);await drain();out.cookies.expire=c.cookie;out.matches.expire=m.id;}
// pending: ranked vs Jev, human moved, Jev's reply not yet computed (left in jev_pending)
{const c=client();await login(c,'pending-user');const m=await start(c,'jev','ranked');await drain();await move(c,m);tasks.length=0;out.cookies.pending=c.cookie;out.matches.pending=m.id;}
out.status=Object.fromEntries(Object.entries(out.matches).map(([k,id])=>[k,DB.db.prepare('SELECT status,revision FROM matches WHERE id=?').get(id)]));
out.tables={};for(const t of ['users','sessions','grants','matches','events','operations','quotas'])out.tables[t]=DB.db.prepare(`SELECT * FROM ${t}`).all().map(r=>({...r}));
await writeFile(process.argv[3],JSON.stringify(out,null,1)+'\n');console.log(JSON.stringify(out.status),Object.fromEntries(Object.entries(out.tables).map(([k,v])=>[k,v.length])));
