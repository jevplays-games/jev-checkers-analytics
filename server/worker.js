import { uid,json,assert,bodyJSON,csrf,secureHeaders,operation,now,all,one,rate,safeEqual,HttpError } from './util.js';
import { getSession,me,loginStart,loginCallback,logout } from './auth.js';
import { interaction,redeem } from './discord.js';
import { activityConfig,createActivitySession } from './activity.js';
import { ownedMatch,snapshot,createMatch,humanAction,advanceMatch,getReplay,maintenance } from './matches.js';
import { leaderboard,playerAnalytics } from './leaderboards.js';
import { analyzeReplay,distribution,toCSV,flatEvents } from '../public/lib/analytics.js';
async function telemetry(body,session,env){
  assert(typeof body.matchId==='string',400,'Match ID required');await ownedMatch(body.matchId,session,env);
  assert(body.consent===true&&Array.isArray(body.events)&&body.events.length<=30,400,'Opt-in consent and at most 30 events required');
  await rate(env,`telemetry:${session.id}`,60,3600);
  const allowed=new Set(['page_ready','board_render','visibility_change','network_retry','action_ack','interaction_error']);
  const events=body.events.map(e=>{assert(allowed.has(e.kind)&&Number.isFinite(e.elapsedMs)&&e.elapsedMs>=0&&e.elapsedMs<=86400000,400,'Invalid telemetry event');
    return {kind:e.kind,elapsedMs:Math.round(e.elapsedMs),visible:e.visible===true};});
  await operation(env,'browser_telemetry',{events},body.matchId,null,'untrusted_client');return json({accepted:events.length,trust:'untrusted_client'});
}
async function adminMetrics(request,env){
  assert(env.ANALYTICS_ADMIN_TOKEN&&await safeEqual(request.headers.get('authorization'),`Bearer ${env.ANALYTICS_ADMIN_TOKEN}`),403,'Operator authorization required');
  const url=new URL(request.url),days=Number(url.searchParams.get('days')||7);assert(Number.isInteger(days)&&days>=1&&days<=90,400,'days must be 1–90');
  const since=now()-days*86400000;
  const kinds=await all(env,'SELECT kind,trust,COUNT(*) AS count FROM operations WHERE created_at>=? GROUP BY kind,trust',since);
  const outcomes=await all(env,`SELECT difficulty,opponent,mode,status,verification,COUNT(*) AS count,SUM(eligible) AS eligible FROM matches WHERE created_at>=? GROUP BY difficulty,opponent,mode,status,verification`,since);
  const provider=await all(env,`SELECT kind,payload_json FROM operations WHERE created_at>=? AND kind IN ('jev_response_validated','jev_attempt_failed')`,since);
  let inputTokens=0,outputTokens=0,unknown=0;const timing=[];
  for(const row of provider){const p=JSON.parse(row.payload_json),a=p.attempt;timing.push(a?.latencyMs);if(a?.usage){inputTokens+=a.usage.input_tokens;outputTokens+=a.usage.output_tokens;}else unknown++;}
  return json({asOf:now(),since,scope:'all matching rows; no sampling',kinds,outcomes,
    provider:{attempts:provider.length,timing:distribution(timing),inputTokens,outputTokens,unknownUsageAttempts:unknown},
    caveat:'Operational counts include failed and discarded attempts. They are not leaderboard scores.'});
}
async function route(request,env,ctx){
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  assert(env.DB,503,'Database is not configured');
  if(path==='/api/health'&&request.method==='GET')return json({ok:true,service:'jev-checkers',version:'1.0.0'});
  if(path==='/api/discord/interactions'&&request.method==='POST')return interaction(request,env);
  if(path==='/api/activity/config'&&request.method==='GET')return activityConfig(env);
  if(path==='/api/activity/session'&&request.method==='POST')return createActivitySession(request,env);
  if(path==='/api/me'&&request.method==='GET')return me(request,env);
  if(path==='/api/auth/discord'&&request.method==='GET')return loginStart(request,env);
  if(path==='/api/auth/discord/callback'&&request.method==='GET')return loginCallback(request,env);
  if(path==='/api/analytics/admin'&&request.method==='GET')return adminMetrics(request,env);
  const session=await getSession(request,env);
  if(path==='/api/leaderboard'&&request.method==='GET')return leaderboard(url,session,env);
  assert(session,401,'Session expired. Reload to continue.');
  if(request.method==='POST')csrf(request,session,env);
  if(path==='/api/logout'&&request.method==='POST')return logout(request,env,session);
  if(path==='/api/launch/redeem'&&request.method==='POST')return redeem(await bodyJSON(request),session,env);
  if(path==='/api/telemetry'&&request.method==='POST')return telemetry(await bodyJSON(request,16384),session,env);
  if(path==='/api/analytics/me'&&request.method==='GET')return playerAnalytics(session,env);
  if(path==='/api/matches'&&request.method==='POST'){
    const match=await createMatch(await bodyJSON(request),session,env);
    if(match.status==='jev_pending')ctx.waitUntil(advanceMatch(match.id,env));return json(match,201);
  }
  const match=path.match(/^\/api\/matches\/([a-zA-Z0-9-]{1,64})(?:\/(actions|advance|replay|analytics|operations))?$/);
  if(match){
    const [,id,action]=match;
    if(action==='actions'&&request.method==='POST'){
      const result=await humanAction(id,await bodyJSON(request),session,env);if(result.status==='jev_pending')ctx.waitUntil(advanceMatch(id,env));return json(result);
    }
    const owned=await ownedMatch(id,session,env);
    if(action==='advance'&&request.method==='POST'){
      await rate(env,`advance:${session.id}`,60,60);ctx.waitUntil(advanceMatch(id,env));return json({status:owned.status},202);
    }
    if(!action&&request.method==='GET')return json(await snapshot(owned,env));
    if(action==='replay'&&request.method==='GET')return json(await getReplay(owned,env));
    if(action==='analytics'&&request.method==='GET'){
      const replay=await getReplay(owned,env),analytics=analyzeReplay(replay),format=url.searchParams.get('format')||'json';
      if(format==='json')return json(analytics);
      if(format==='moves.csv'||format==='candidates.csv'||format==='events.csv')return new Response(toCSV(format==='moves.csv'?analytics.moves:format==='candidates.csv'?analytics.candidates:flatEvents(replay)),{headers:{'content-type':'text/csv; charset=utf-8','cache-control':'no-store'}});
      throw new HttpError(400,'Unknown export format');
    }
    if(action==='operations'&&request.method==='GET'){
      const after=Number(url.searchParams.get('after')||0),afterId=url.searchParams.get('afterId')||'';
      assert(Number.isSafeInteger(after)&&after>=0&&afterId.length<=64,400,'Invalid operation cursor');
      const rows=await all(env,`SELECT * FROM operations WHERE match_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 500`,id,after,after,afterId);
      return json({entries:rows.map(r=>({id:r.id,at:r.created_at,kind:r.kind,trust:r.trust,requestId:r.request_id,payload:JSON.parse(r.payload_json)})),
        next:rows.length===500?{after:rows.at(-1).created_at,afterId:rows.at(-1).id}:null});
    }
  }
  throw new HttpError(404,'Endpoint not found');
}
export default {
  async fetch(request,env,ctx){
    const started=performance.now(),requestId=uid();let response;
    try{response=await route(request,env,ctx);}catch(error){
      const status=error instanceof HttpError?error.status:500;
      response=json({error:status===500?'Internal server error':error.message,code:error.code||'internal_error',requestId},status);
      if(status===500)console.error(JSON.stringify({kind:'internal_error',requestId,errorType:error.name}));
    }
    // No raw URL, query parameters, request body, IP, cookies or OAuth codes in request logs.
    const {pathname,searchParams}=new URL(request.url);
    if(pathname.startsWith('/api/')&&env.LOG_REQUESTS==='true')console.log(JSON.stringify({kind:'http_request',requestId,status:response.status,durationMs:performance.now()-started,method:request.method}));
    return secureHeaders(response,requestId,!pathname.startsWith('/api/')&&searchParams.has('frame_id'));
  },
  async scheduled(_event,env,ctx){ctx.waitUntil(maintenance(env));}
};
