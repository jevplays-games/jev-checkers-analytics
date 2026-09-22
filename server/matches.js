import { createInitialState,getLegalActions,getOutcome,applyAction,serialize,deserialize,otherSide } from '../public/games/checkers/rules.js';
import { profileFor,chooseLocalAction,features } from '../public/games/checkers/strategy.js';
import { sha256,hashState,sealEvent,verifyReplay,canonical } from '../public/lib/audit.js';
import { chooseJevAction } from './jev.js';
import { one,all,run,uid,token,now,assert,keysOnly,requestId,rate,operation,json,HttpError } from './util.js';
export async function ownedMatch(id,session,env){
  const m=await one(env,'SELECT * FROM matches WHERE id=?',id);
  assert(m&&(m.owner_session===session.id||(m.user_id&&m.user_id===session.user_id)),404,'Match not found');return m;
}
export async function snapshot(m,env){
  const state=deserialize(m.state_json),last=await one(env,'SELECT body_json FROM events WHERE match_id=? ORDER BY seq DESC LIMIT 1',m.id);
  return {id:m.id,state,revision:m.revision,status:m.status,humanSide:m.human_side,opponent:m.opponent,difficulty:m.difficulty,
    mode:m.mode,cohort:m.cohort,eligible:!!m.eligible,verification:m.verification,outcome:m.outcome_json?JSON.parse(m.outcome_json):null,
    legalActions:getOutcome(state)?[]:getLegalActions(state),lastEvent:last?JSON.parse(last.body_json):null,humanDeadline:m.human_deadline,
    context:m.guild_id?{guildId:m.guild_id,channelId:m.channel_id}:null};
}
export async function createMatch(body,session,env){
  keysOnly(body,['gameId','mode','difficulty','requestId','opponent']);
  assert(body.gameId==='checkers',400,'Unsupported game');requestId(body.requestId);
  assert(['casual','ranked'].includes(body.mode),400,'Invalid mode');
  assert(['jev','local'].includes(body.opponent),400,'Invalid opponent');
  let profile;try{profile=profileFor(body.difficulty);}catch{throw new HttpError(400,'Unknown difficulty');}
  const startKey=`${session.id}:${body.requestId}`,requestHash=await sha256(body);
  const previous=await one(env,'SELECT * FROM matches WHERE start_key=?',startKey);
  if(previous){assert(previous.request_hash===requestHash,409,'Request ID reused with different content');return snapshot(previous,env);}
  assert(body.opponent!=='jev'||env.TYPESAFE_API_KEY,503,'Remote JEV is not configured');
  assert(body.mode!=='ranked'||(session.user_id&&body.opponent==='jev'&&env.TYPESAFE_API_KEY),403,'Ranked play requires Discord and the real JEV opponent');
  const day=new Date().toISOString().slice(0,10);
  await rate(env,`match:${session.user_id||session.id}:${day}`,session.user_id?30:5,86400);
  if(body.opponent==='jev')await rate(env,`global-jev-starts:${day}`,Number(env.GLOBAL_DAILY_MATCH_LIMIT||200),86400);
  const active=await one(env,`SELECT id FROM matches WHERE (owner_session=? OR (user_id IS NOT NULL AND user_id=?)) AND status IN ('human_turn','jev_pending','verifying') LIMIT 1`,session.id,session.user_id);
  assert(!active,409,'Finish or resume your active match first');
  const id=uid(),cohort=await sha256(profile),time=now(),state=createInitialState();
  const played=session.user_id?await one(env,`SELECT COUNT(*) AS count FROM matches WHERE user_id=? AND cohort=? AND mode='ranked'`,session.user_id,cohort):{count:0};
  const humanSide=body.mode==='ranked'&&played.count%2?'white':'red';
  const context=session.context_json?JSON.parse(session.context_json):null;
  const community=body.mode==='ranked'&&context&&!context.used&&context.expiresAt>time?context:null;
  const manifest={formatVersion:1,matchId:id,gameId:'checkers',rulesVersion:state.rulesVersion,engineVersion:state.engineVersion,
    buildId:env.BUILD_ID||'source-release-1.0.0',initialState:state,officialStart:true,humanSide,opponent:body.opponent,
    profile,profileHash:cohort,trust:'trusted_server',startedAt:new Date(time).toISOString()};
  const head=await sha256(manifest),status=humanSide==='red'?'human_turn':'jev_pending';
  const values=[id,startKey,requestHash,session.id,session.user_id,body.mode,body.opponent,body.difficulty,humanSide,
    community?.guildId||null,community?.channelId||null,community?.launchHash||null,cohort,JSON.stringify(manifest),serialize(state),head,status,time,time,status==='human_turn'?time+86400000:null];
  const columns='id,start_key,request_hash,owner_session,user_id,mode,opponent,difficulty,human_side,guild_id,channel_id,launch_hash,cohort,manifest_json,state_json,chain_head,status,created_at,updated_at,human_deadline';
  try{
    if(community){
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO matches(${columns}) SELECT ${values.map(()=>'?').join(',')} WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND json_extract(context_json,'$.launchHash')=? AND json_extract(context_json,'$.used')=0 AND json_extract(context_json,'$.expiresAt')>?)`).bind(...values,session.id,community.launchHash,time),
        env.DB.prepare(`UPDATE sessions SET context_json=json_set(context_json,'$.used',json('true')) WHERE id=? AND EXISTS(SELECT 1 FROM matches WHERE id=?)`).bind(session.id,id)
      ]);
    }else await run(env,`INSERT INTO matches(${columns}) VALUES (${values.map(()=>'?').join(',')})`,...values);
  }catch(error){
    if(/UNIQUE|constraint/i.test(error.message))throw new HttpError(409,'A conflicting match already exists');throw error;
  }
  const saved=await one(env,'SELECT * FROM matches WHERE id=?',id);assert(saved,409,'Community launch entitlement was already used');
  await operation(env,'game_started',{opponent:body.opponent,mode:body.mode,cohort},id);
  return snapshot(saved,env);
}
async function commitEvent(m,env,{kind,actor,action=null,evidence={},requestKey,requestHash,lease=null}){
  const state=deserialize(m.state_json),next=kind==='move'?applyAction(state,action.id):state,time=now();
  const event=await sealEvent({matchId:m.id,seq:m.revision+1,at:new Date(time).toISOString(),kind,actor,
    action,evidence,turnMs:time-m.updated_at,preHash:await hashState(state),postHash:await hashState(next)},m.chain_head);
  const outcome=kind==='move'?getOutcome(next):{winner:kind==='service_failure'?null:otherSide(m.human_side),reason:kind};
  const status=outcome?'verifying':next.toMove===m.human_side?'human_turn':'jev_pending',commit=token();
  const sql=`UPDATE matches SET state_json=?,revision=revision+1,chain_head=?,status=?,outcome_json=?,updated_at=?,human_deadline=?,lease_token=NULL,lease_until=NULL,last_commit=?
    WHERE id=? AND revision=? ${lease?'AND lease_token=? AND lease_until>?':''}`;
  const params=[serialize(next),event.eventHash,status,outcome?JSON.stringify(outcome):null,time,status==='human_turn'?time+86400000:null,commit,m.id,m.revision,...(lease?[lease,time]:[])];
  const result=await env.DB.batch([
    env.DB.prepare(sql).bind(...params),
    env.DB.prepare(`INSERT INTO events(match_id,seq,request_key,request_hash,kind,body_json,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND last_commit=?)`).bind(m.id,event.seq,requestKey,requestHash,kind,JSON.stringify(event),time,m.id,commit)
  ]);
  if(!result[0].meta.changes)return null;
  await operation(env,kind==='move'?actor==='human'?'human_action':'opponent_action':kind,{seq:event.seq,actionId:action?.id||null,source:evidence.source||null},m.id,requestKey);
  return await one(env,'SELECT * FROM matches WHERE id=?',m.id);
}
export async function humanAction(id,body,session,env){
  keysOnly(body,['expectedRevision','requestId','actionId','resign']);requestId(body.requestId);
  assert(Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>=0,400,'Invalid revision');
  assert((typeof body.actionId==='string') !== (body.resign===true),400,'Specify exactly one move or resignation');
  const m=await ownedMatch(id,session,env),hash=await sha256(body);
  const prior=await one(env,'SELECT request_hash FROM events WHERE match_id=? AND request_key=?',id,body.requestId);
  if(prior){assert(prior.request_hash===hash,409,'Request ID reused with different content');return snapshot(m,env);}
  assert(m.revision===body.expectedRevision,409,'State changed. Refresh the match.','stale_revision');
  assert(m.status==='human_turn',409,'It is not your turn');
  assert(m.human_deadline>now(),409,'Turn deadline expired');
  await rate(env,`actions:${session.id}`,120,60);
  const state=deserialize(m.state_json),action=body.resign?null:getLegalActions(state).find(a=>a.id===body.actionId);
  assert(body.resign||action,422,'Illegal move. Submit the complete capture chain.');
  const saved=await commitEvent(m,env,{kind:body.resign?'resign':'move',actor:'human',action,evidence:{features:features(state)},requestKey:body.requestId,requestHash:hash});
  assert(saved,409,'Concurrent action already committed','stale_revision');
  if(saved.status==='verifying')await finalizeMatch(id,env);
  return snapshot(await one(env,'SELECT * FROM matches WHERE id=?',id),env);
}
export async function advanceMatch(id,env){
  let m=await one(env,'SELECT * FROM matches WHERE id=?',id);
  if(!m)return;
  if(m.status==='verifying'){await finalizeMatch(id,env);return;}
  if(m.status!=='jev_pending')return;
  const lease=token(),time=now();
  const acquired=await run(env,`UPDATE matches SET lease_token=?,lease_until=? WHERE id=? AND revision=? AND status='jev_pending' AND (lease_until IS NULL OR lease_until<=?)`,lease,time+30000,id,m.revision,time);
  if(!acquired.meta.changes)return;
  m=await one(env,'SELECT * FROM matches WHERE id=?',id);
  const state=deserialize(m.state_json),manifest=JSON.parse(m.manifest_json);
  try{
    const decision=m.opponent==='jev'?await chooseJevAction(state,m.difficulty,env,{matchId:id,profile:manifest.profile}):chooseLocalAction(state,m.difficulty);
    const action=getLegalActions(state).find(a=>a.id===decision.actionId);assert(action,500,'Opponent selected an invalid action');
    const evidence={...decision.evidence,source:decision.source,model:decision.model,
      stateHash:await hashState(state),profileHash:manifest.profileHash};
    const saved=await commitEvent(m,env,{kind:'move',actor:'opponent',action,evidence,
      requestKey:`opponent-${m.revision}-${lease}`,requestHash:await sha256(decision),lease});
    if(!saved){await operation(env,'stale_decision_discarded',{revision:m.revision,decisionId:evidence.decisionId||null},id);return;}
    if(saved.status==='verifying')await finalizeMatch(id,env);
  }catch(error){
    await operation(env,'opponent_failure',{code:error.code||'internal_opponent_error'},id);
    const saved=await commitEvent(m,env,{kind:'service_failure',actor:'system',evidence:{...error.evidence,source:'system',code:error.code||'internal_opponent_error'},
      requestKey:`failure-${m.revision}-${lease}`,requestHash:await sha256({lease,revision:m.revision}),lease});
    if(saved)await finalizeMatch(id,env);
  }
}
export async function getReplay(m,env){
  const events=await all(env,'SELECT body_json FROM events WHERE match_id=? ORDER BY seq',m.id);
  return {format:'jev-checkers-audit',version:1,manifest:JSON.parse(m.manifest_json),events:events.map(e=>JSON.parse(e.body_json)),
    finalState:deserialize(m.state_json),finalHash:m.chain_head,outcome:m.outcome_json?JSON.parse(m.outcome_json):null,
    verification:m.verification,eligible:!!m.eligible};
}
export async function finalizeMatch(id,env){
  const m=await one(env,'SELECT * FROM matches WHERE id=?',id);if(!m||m.status!=='verifying')return;
  try{
    const replay=await getReplay(m,env),checked=await verifyReplay(replay);assert(checked.outcome,500,'Cannot finalize unfinished match');
    assert(await sha256(replay.manifest.profile)===m.cohort&&replay.manifest.profileHash===m.cohort,500,'Profile changed');
    for(const event of replay.events){
      if(event.actor!=='opponent')continue;
      assert(event.evidence?.profileHash===m.cohort&&event.evidence.stateHash===event.preHash,500,'Opponent evidence mismatch');
      if(event.evidence.source==='jev'){
        const evidence=await one(env,`SELECT payload_json FROM operations WHERE match_id=? AND request_id=? AND kind='jev_response_validated' ORDER BY created_at DESC LIMIT 1`,id,event.evidence.decisionId);
        assert(evidence,500,'Missing server-side provider provenance');
        const recorded=JSON.parse(evidence.payload_json);
        assert(recorded.requestHash===event.evidence.requestHash&&canonical(recorded.response.answers)===canonical(event.evidence.answers),500,'Provider evidence changed');
      }
    }
    const voided=checked.outcome.reason==='service_failure',eligible=m.mode==='ranked'&&m.opponent==='jev'&&!!m.user_id&&!voided;
    const units=voided?null:checked.outcome.winner===null?1:checked.outcome.winner===m.human_side?2:0;
    const result=await run(env,`UPDATE matches SET status=?,verification='verified',eligible=?,result_units=?,finished_at=? WHERE id=? AND status='verifying' AND revision=?`,voided?'void':'complete',Number(eligible),units,now(),id,m.revision);
    if(result.meta.changes)await operation(env,'score_verified',{eligible,units,outcome:checked.outcome,eventCount:checked.eventCount,finalHash:checked.finalHash},id);
  }catch(error){
    await run(env,`UPDATE matches SET status='void',verification='rejected',eligible=0,finished_at=? WHERE id=? AND status='verifying'`,now(),id);
    await operation(env,'verification_failed',{code:'replay_or_provenance_mismatch'},id);
  }
}
export async function maintenance(env){
  const pending=await all(env,`SELECT id FROM matches WHERE status='verifying' OR (status='jev_pending' AND (lease_until IS NULL OR lease_until<=?)) ORDER BY updated_at LIMIT 10`,now());
  for(const m of pending)await advanceMatch(m.id,env);
  const expired=await all(env,`SELECT * FROM matches WHERE status='human_turn' AND human_deadline<=? LIMIT 25`,now());
  for(const m of expired){const saved=await commitEvent(m,env,{kind:'abandoned',actor:'system',evidence:{deadline:m.human_deadline},requestKey:`abandoned-${m.revision}`,requestHash:await sha256({deadline:m.human_deadline})});if(saved)await finalizeMatch(m.id,env);}
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants WHERE expires_at<?').bind(now()-86400000),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),
    env.DB.prepare('DELETE FROM quotas WHERE expires_at<?').bind(now()),
    env.DB.prepare("DELETE FROM operations WHERE trust='untrusted_client' AND created_at<?").bind(now()-7*86400000)
  ]);
}
