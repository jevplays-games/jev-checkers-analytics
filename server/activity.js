// Discord Activity support. Discord loads the game in an iframe on <application id>.discordsays.com, where a
// SameSite cookie is not sent, so the game signs the player in through the Embedded App SDK and then keeps a
// bearer session token in memory. Nothing here changes the normal browser sign-in.
import { token,uid,sha256,run,now,json,assert,bodyJSON,origin,operation,rate,activityOrigin } from './util.js';
import { authEnabled,upsertDiscordUser } from './auth.js';
const API='https://discord.com/api/v10';
export function activityConfig(env){
  assert(authEnabled(env),503,'Discord is not configured');
  return json({clientId:env.DISCORD_APPLICATION_ID});
}
export async function createActivitySession(request,env){
  assert(authEnabled(env),503,'Discord is not configured');
  const got=request.headers.get('origin');
  assert(got&&(got===activityOrigin(env)||got===origin(env,request)),403,'Origin mismatch');
  await rate(env,`activity-session:${request.headers.get('cf-connecting-ip')||'unknown'}`,60,3600);
  const {code}=await bodyJSON(request,4096);
  assert(typeof code==='string'&&code.length>0&&code.length<2048,400,'Missing authorization code');
  const call=env.FETCH||fetch;
  // An SDK authorization code is exchanged without a redirect URI.
  const tokenResponse=await call('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code}).toString(),signal:AbortSignal.timeout(8000)});
  assert(tokenResponse.ok,502,'Discord token exchange failed');const tokens=await tokenResponse.json();assert(typeof tokens.access_token==='string',502,'Discord did not return an access token');
  const response=await call(`${API}/users/@me`,{headers:{authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(8000)});
  assert(response.ok,502,'Discord identity lookup failed');
  const user=await upsertDiscordUser(env,await response.json()),raw=token(),csrf=token();
  await run(env,'INSERT INTO sessions(id,token_hash,user_id,csrf,context_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',uid(),await sha256(raw),user.id,csrf,null,now(),now()+86400000);
  await operation(env,'auth_success',{userId:user.id,surface:'activity'});
  // The Discord access token is returned once so the SDK can authenticate; it is never stored or logged.
  return json({token:raw,csrf,accessToken:tokens.access_token,user:{id:user.id,displayName:user.display_name}});
}
