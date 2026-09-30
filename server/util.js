import { sha256, canonical } from '../public/lib/audit.js';
export { sha256, canonical };
export class HttpError extends Error { constructor(status,message,code='request_error'){super(message);this.status=status;this.code=code;} }
export const assert = (condition,status,message,code) => { if(!condition)throw new HttpError(status,message,code); };
export const uid = () => crypto.randomUUID();
export function token() { const b=new Uint8Array(32);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export const now = () => Date.now();
export const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
export const redirect = (location,headers={}) => new Response(null,{status:302,headers:{location,'cache-control':'no-store',...headers}});
export async function readText(request,max=65536) {
  if(Number(request.headers.get('content-length'))>max)throw new HttpError(413,'Payload too large');
  if(!request.body)return '';
  const reader=request.body.getReader(),chunks=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new HttpError(413,'Payload too large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return new TextDecoder().decode(bytes);
}
export async function bodyJSON(request,max=65536) {
  assert(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'Expected application/json');
  try{const value=JSON.parse(await readText(request,max));assert(value && typeof value==='object' && !Array.isArray(value),400,'Expected an object');return value;}
  catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'Invalid JSON');}
}
export function keysOnly(object,allowed) { assert(Object.keys(object).every(k=>allowed.includes(k)),400,'Unexpected request field'); }
export function requestId(value) { assert(typeof value==='string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value),400,'Invalid request ID');return value; }
export const one = (env,sql,...args) => env.DB.prepare(sql).bind(...args).first();
export async function all(env,sql,...args) { return (await env.DB.prepare(sql).bind(...args).all()).results; }
export const run = (env,sql,...args) => env.DB.prepare(sql).bind(...args).run();
export async function operation(env,kind,payload={},matchId=null,request=null,trust='trusted_server') {
  // Callers supply allowlisted objects, never raw headers, URLs, access tokens or exceptions.
  await run(env,'INSERT INTO operations VALUES (?,?,?,?,?,?,?)',uid(),matchId,request,kind,trust,canonical(payload),now());
}
export async function rate(env,bucket,limit,seconds) {
  const time=now(),expiry=time+seconds*1000;
  const result=await one(env,`INSERT INTO quotas(bucket,hits,expires_at) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN expires_at<=? THEN 1 ELSE hits+1 END,
    expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING hits`,bucket,expiry,time,time,expiry);
  assert(result.hits<=limit,429,'Usage limit reached. Try again later.','rate_limited');
}
// Discord shows an Activity inside its own iframe. Only a page loaded with Discord's frame_id may be framed, and only by Discord.
export const ACTIVITY_FRAME_ANCESTORS='frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com';
export function secureHeaders(response,requestIdValue,framable=false) {
  const headers=new Headers(response.headers);
  headers.set('x-content-type-options','nosniff');headers.set('referrer-policy','no-referrer');
  const csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  headers.set('content-security-policy',framable?csp.replace("frame-ancestors 'none'",ACTIVITY_FRAME_ANCESTORS):csp);
  if(framable)headers.delete('x-frame-options');
  headers.set('permissions-policy','camera=(), microphone=(), geolocation=()');headers.set('x-request-id',requestIdValue);
  return new Response(response.body,{status:response.status,headers});
}
export async function safeEqual(a,b) { if(typeof a!=='string'||typeof b!=='string')return false;return await sha256(a)===await sha256(b); }
export function origin(env,request) {
  const result=env.APP_ORIGIN || new URL(request.url).origin;
  assert(new URL(result).origin===result,500,'APP_ORIGIN must be an origin without a trailing slash');
  return result;
}
export const activityOrigin=env=>/^\d{5,25}$/.test(env.DISCORD_APPLICATION_ID??'')?`https://${env.DISCORD_APPLICATION_ID}.discordsays.com`:null;
export function csrf(request,session,env) {
  // The Activity origin is honored only for bearer sessions: a cookie session must never be usable from it.
  const got=request.headers.get('origin'),framed=session?.via==='bearer'?activityOrigin(env):null;
  assert(got===origin(env,request)||(framed&&got===framed),403,'Origin mismatch');
  assert(session && request.headers.get('x-csrf-token')===session.csrf,403,'CSRF token mismatch');
}
