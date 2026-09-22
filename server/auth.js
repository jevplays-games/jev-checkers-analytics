import { token,uid,sha256,one,run,now,json,redirect,assert,origin,operation,rate } from './util.js';
const API='https://discord.com/api/v10';
export function authEnabled(env){return !!(env.DISCORD_APPLICATION_ID&&env.DISCORD_CLIENT_SECRET);}
function local(env,request){return env.APP_ENV==='local'&&['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);}
export function sessionCookie(value,env,request,maxAge=604800){
  const dev=local(env,request),name=dev?'jev_dev_session':'__Host-jev_session';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${dev?'':'; Secure'}`;
}
export async function getSession(request,env){
  const name=local(env,request)?'jev_dev_session':'__Host-jev_session';
  const value=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
  if(!value||!/^[a-f0-9]{64}$/.test(value))return null;
  const session=await one(env,`SELECT s.*,u.discord_id,u.display_name,u.avatar_ref,u.disabled FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,await sha256(value),now());
  if(session?.disabled)return null;return session;
}
export async function ensureSession(request,env){
  let session=await getSession(request,env);if(session)return {session,cookie:null};
  const raw=token();session={id:uid(),token_hash:await sha256(raw),user_id:null,csrf:token(),context_json:null,created_at:now(),expires_at:now()+7*86400000};
  await run(env,'INSERT INTO sessions(id,token_hash,user_id,csrf,context_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',...Object.values(session));
  return {session,cookie:sessionCookie(raw,env,request)};
}
export async function loginStart(request,env){
  assert(authEnabled(env),503,'Discord sign-in has not been configured');
  const {session,cookie}=await ensureSession(request,env);await rate(env,`oauth:${session.id}`,10,600);
  const state=token(),url=new URL(request.url),returnTo=url.searchParams.get('return')||'/';
  assert(returnTo==='/'||returnTo==='/play/checkers',400,'Invalid return path');
  await run(env,'INSERT INTO grants(token_hash,purpose,session_id,payload_json,expires_at) VALUES (?,?,?,?,?)',await sha256(state),'oauth',session.id,JSON.stringify({returnTo}),now()+600000);
  const target=new URL('https://discord.com/oauth2/authorize');
  target.search=new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,response_type:'code',redirect_uri:`${origin(env,request)}/api/auth/discord/callback`,scope:'identify',state});
  return redirect(target.toString(),cookie?{'set-cookie':cookie}:{});
}
export async function loginCallback(request,env){
  assert(authEnabled(env),503,'Discord is not configured');const session=await getSession(request,env);assert(session,401,'Login session expired');
  const url=new URL(request.url),state=url.searchParams.get('state');assert(state&&/^[a-f0-9]{64}$/.test(state),400,'Invalid OAuth state');
  const grant=await one(env,`UPDATE grants SET consumed_at=? WHERE token_hash=? AND purpose='oauth' AND session_id=? AND expires_at>? AND consumed_at IS NULL RETURNING *`,now(),await sha256(state),session.id,now());
  assert(grant,400,'OAuth state expired, reused or mismatched');
  assert(!url.searchParams.has('error'),400,'Discord authorization was not granted');
  const code=url.searchParams.get('code');assert(code&&code.length<2048,400,'Missing authorization code');
  const form=new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:`${origin(env,request)}/api/auth/discord/callback`});
  const call=env.FETCH||fetch;
  const tokenResponse=await call('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form.toString(),signal:AbortSignal.timeout(8000)});
  assert(tokenResponse.ok,502,'Discord token exchange failed');const tokens=await tokenResponse.json();assert(typeof tokens.access_token==='string',502,'Discord did not return an access token');
  let user;
  try{
    const response=await call(`${API}/users/@me`,{headers:{authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(8000)});
    assert(response.ok,502,'Discord identity lookup failed');user=await response.json();
  }finally{
    try{await call('https://discord.com/api/oauth2/token/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,client_secret:env.DISCORD_CLIENT_SECRET,token:tokens.access_token}).toString(),signal:AbortSignal.timeout(4000)});}catch{/* Token is not retained. */}
  }
  assert(user&&/^\d{6,24}$/.test(user.id)&&typeof user.username==='string',502,'Invalid Discord identity');
  const display=(user.global_name||user.username).slice(0,80),id=uid();
  await run(env,`INSERT INTO users(id,discord_id,display_name,avatar_ref,created_at,last_seen) VALUES (?,?,?,?,?,?)
    ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,avatar_ref=excluded.avatar_ref,last_seen=excluded.last_seen`,id,user.id,display,user.avatar||null,now(),now());
  const saved=await one(env,'SELECT * FROM users WHERE discord_id=?',user.id);assert(!saved.disabled,403,'Account is disabled');
  const raw=token();await run(env,'UPDATE sessions SET token_hash=?,user_id=?,csrf=?,context_json=NULL,expires_at=? WHERE id=?',await sha256(raw),saved.id,token(),now()+7*86400000,session.id);
  await operation(env,'auth_success',{userId:saved.id});return redirect(JSON.parse(grant.payload_json).returnTo,{'set-cookie':sessionCookie(raw,env,request)});
}
export async function logout(request,env,session){await run(env,'DELETE FROM sessions WHERE id=?',session.id);return json({ok:true},200,{'set-cookie':sessionCookie('',env,request,0)});}
export async function me(request,env){
  const {session,cookie}=await ensureSession(request,env);
  const active=await one(env,`SELECT id FROM matches WHERE (owner_session=? OR (user_id IS NOT NULL AND user_id=?)) AND status IN ('human_turn','jev_pending','verifying') ORDER BY created_at DESC LIMIT 1`,session.id,session.user_id);
  const context=session.context_json?JSON.parse(session.context_json):null;
  return json({user:session.user_id?{id:session.user_id,displayName:session.display_name}:null,csrf:session.csrf,
    context:context&&context.expiresAt>now()?{guildId:context.guildId,channelId:context.channelId,expiresAt:context.expiresAt,matchAvailable:!context.used}:null,
    activeMatchId:active?.id||null,capabilities:{jev:!!env.TYPESAFE_API_KEY,discord:authEnabled(env),ranked:!!env.TYPESAFE_API_KEY&&authEnabled(env)},
    analytics:{schemaVersion:1,browserTelemetry:'off_by_default',matchAudit:'server-recorded'}},200,cookie?{'set-cookie':cookie}:{});
}
