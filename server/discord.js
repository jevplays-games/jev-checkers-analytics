import { token,sha256,one,run,now,json,assert,readText,origin,operation,keysOnly,rate } from './util.js';
export async function verifyInteraction(request,env,raw){
  const signature=request.headers.get('x-signature-ed25519'),timestamp=request.headers.get('x-signature-timestamp');
  assert(env.DISCORD_PUBLIC_KEY&&/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY),503,'Discord public key is not configured');
  assert(signature&&/^[a-f0-9]{128}$/i.test(signature)&&timestamp&&/^\d{10,12}$/.test(timestamp),401,'Missing or invalid Discord signature');
  assert(Math.abs(now()-Number(timestamp)*1000)<=300000,401,'Expired interaction timestamp');
  const hex=s=>Uint8Array.from(s.match(/../g).map(v=>parseInt(v,16)));
  const key=await crypto.subtle.importKey('raw',hex(env.DISCORD_PUBLIC_KEY),{name:'Ed25519'},false,['verify']);
  assert(await crypto.subtle.verify('Ed25519',key,hex(signature),new TextEncoder().encode(timestamp+raw)),401,'Invalid Discord signature');
}
export async function interaction(request,env){
  const raw=await readText(request,65536);await verifyInteraction(request,env,raw);let data;
  try{data=JSON.parse(raw);}catch{assert(false,400,'Invalid interaction JSON');}
  assert(data.application_id===env.DISCORD_APPLICATION_ID,401,'Wrong Discord application');
  if(data.type===1)return json({type:1});
  assert(data.type===2&&data.data?.name==='play'&&data.data?.options?.some(o=>o.type===1&&o.name==='checkers'),400,'Unsupported command');
  assert(data.context===0&&data.guild_id&&data.authorizing_integration_owners?.['0']===data.guild_id,403,'Guild installation required');
  assert(data.channel?.type===0&&data.channel_id===data.channel.id,403,'Only ordinary guild text channels are supported');
  const subject=data.member?.user?.id;assert(subject&&/^\d{6,24}$/.test(subject),403,'Invoking member missing');
  await rate(env,`launch:${subject}`,20,600);
  if(await one(env,'SELECT token_hash FROM grants WHERE interaction_id=?',data.id))return json({type:4,data:{flags:64,content:'This interaction was already handled. Run /play checkers again.'}});
  const rawToken=token(),issuedAt=now(),payload={subjectDiscordId:subject,guildId:data.guild_id,channelId:data.channel_id,gameId:'checkers',interactionId:data.id,issuedAt};
  await run(env,'INSERT INTO grants(token_hash,purpose,subject_id,interaction_id,payload_json,expires_at) VALUES (?,?,?,?,?,?)',await sha256(rawToken),'launch',subject,data.id,JSON.stringify(payload),issuedAt+600000);
  await operation(env,'launch_issued',{interactionId:data.id});
  return json({type:4,data:{flags:64,content:'Play Checkers against JEV. This single-use link is bound to your Discord account and expires in ten minutes.',
    components:[{type:1,components:[{type:2,style:5,label:'Open Checkers',url:`${origin(env,request)}/play/checkers?launch=${rawToken}`}]}]}});
}
export async function redeem(body,session,env){
  keysOnly(body,['token']);assert(session.user_id&&session.discord_id,401,'Sign in with Discord before redeeming the launch');
  assert(typeof body.token==='string'&&/^[a-f0-9]{64}$/.test(body.token),400,'Invalid launch token');
  const hash=await sha256(body.token),consumer=token(),time=now();
  // The grant claim and session-context write are one transaction. The claim is account-bound.
  await env.DB.batch([
    env.DB.prepare(`UPDATE grants SET consumed_at=?,consumer=? WHERE token_hash=? AND purpose='launch' AND subject_id=? AND expires_at>? AND consumed_at IS NULL`).bind(time,consumer,hash,session.discord_id,time),
    env.DB.prepare(`UPDATE sessions SET context_json=(SELECT json_set(payload_json,'$.launchHash',token_hash,'$.expiresAt',json_extract(payload_json,'$.issuedAt')+900000,'$.used',json('false')) FROM grants WHERE token_hash=? AND consumer=?) WHERE id=? AND EXISTS(SELECT 1 FROM grants WHERE token_hash=? AND consumer=?)`).bind(hash,consumer,session.id,hash,consumer)
  ]);
  const grant=await one(env,'SELECT consumer FROM grants WHERE token_hash=?',hash);assert(grant?.consumer===consumer,403,'Launch expired, used, or belongs to another account');
  await operation(env,'launch_redeemed',{userId:session.user_id});return json({ok:true});
}
