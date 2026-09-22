import { one,all,now,assert,json,HttpError } from './util.js';
import { profileFor } from '../public/games/checkers/strategy.js';
import { sha256 } from '../public/lib/audit.js';
export function balancedScore(redUnits,redGames,whiteUnits,whiteGames){
  return redGames&&whiteGames?25*(redUnits/redGames+whiteUnits/whiteGames):null;
}
export function compareBalanced(a,b){
  const qualifiedA=a.redGames>=10&&a.whiteGames>=10,qualifiedB=b.redGames>=10&&b.whiteGames>=10;
  if(qualifiedA!==qualifiedB)return qualifiedA?-1:1;
  const numerator=x=>BigInt(x.redUnits)*BigInt(x.whiteGames)+BigInt(x.whiteUnits)*BigInt(x.redGames);
  const denominator=x=>BigInt(x.redGames)*BigInt(x.whiteGames);
  const da=denominator(a),db=denominator(b);
  if(da&&db){const d=numerator(b)*da-numerator(a)*db;if(d!==0n)return d>0n?1:-1;}
  else if(da!==db)return da?-1:1;
  return b.games-a.games||b.wins-a.wins||(a.id<b.id?-1:a.id>b.id?1:0);
}
function communityWhere(scope,session){
  assert(['world','server','channel'].includes(scope),400,'Unknown leaderboard scope');
  if(scope==='world')return {sql:'',args:[]};
  const context=session?.context_json?JSON.parse(session.context_json):null;
  assert(session?.user_id&&context&&context.expiresAt>now(),403,'Refresh your Discord channel launch to view this community');
  return {sql:scope==='server'?' AND m.guild_id=?':' AND m.channel_id=? AND m.guild_id=?',args:scope==='server'?[context.guildId]:[context.channelId,context.guildId]};
}
export async function leaderboard(url,session,env){
  const scope=url.searchParams.get('scope')||'world',difficulty=url.searchParams.get('difficulty')||'normal';
  let profile;try{profile=profileFor(difficulty);}catch{throw new HttpError(400,'Unknown difficulty');}
  const cohort=url.searchParams.get('cohort')||await sha256(profile);
  assert(/^[a-f0-9]{64}$/.test(cohort),400,'Invalid cohort');
  const filter=communityWhere(scope,session);let offset=0,asOf=now();
  const cursor=url.searchParams.get('cursor');
  if(cursor){let parsed;try{parsed=JSON.parse(atob(cursor));}catch{throw new HttpError(400,'Invalid cursor');}
    assert(parsed.scope===scope&&parsed.cohort===cohort&&Number.isSafeInteger(parsed.offset)&&parsed.offset>=0&&Number.isSafeInteger(parsed.asOf)&&parsed.asOf<=now(),400,'Cursor mismatch');offset=parsed.offset;asOf=parsed.asOf;}
  const where=`m.eligible=1 AND m.verification='verified' AND m.cohort=? AND m.finished_at<=? AND u.disabled=0${filter.sql}`;
  const rows=await all(env,`SELECT u.id,u.display_name AS name,COUNT(*) AS games,
    SUM(m.result_units=2) AS wins,SUM(m.result_units=1) AS draws,SUM(m.result_units=0) AS losses,
    SUM(m.human_side='red') AS redGames,SUM(m.human_side='white') AS whiteGames,
    SUM(CASE WHEN m.human_side='red' THEN m.result_units ELSE 0 END) AS redUnits,
    SUM(CASE WHEN m.human_side='white' THEN m.result_units ELSE 0 END) AS whiteUnits
    FROM matches m JOIN users u ON u.id=m.user_id WHERE ${where} GROUP BY u.id`,cohort,asOf,...filter.args);
  rows.sort(compareBalanced);
  const page=rows.slice(offset,offset+50).map((r,i)=>({...r,balancedScore:balancedScore(r.redUnits,r.redGames,r.whiteUnits,r.whiteGames),
    provisional:r.redGames<10||r.whiteGames<10,rank:r.redGames>=10&&r.whiteGames>=10?offset+i+1:null,
    currentStreak:0,bestStreak:0}));
  if(page.length){
    const results=await all(env,`SELECT m.user_id,m.result_units FROM matches m JOIN users u ON u.id=m.user_id WHERE ${where} AND m.user_id IN (${page.map(()=>'?').join(',')}) ORDER BY m.finished_at,m.id`,cohort,asOf,...filter.args,...page.map(p=>p.id));
    const byId=Object.fromEntries(page.map(p=>[p.id,p]));
    for(const r of results){const p=byId[r.user_id];p.currentStreak=r.result_units===2?p.currentStreak+1:0;p.bestStreak=Math.max(p.bestStreak,p.currentStreak);}
  }
  return json({scope,cohort,difficulty,asOf,total:rows.length,qualification:'10 verified games per color in this scope and cohort',entries:page,
    nextCursor:offset+50<rows.length?btoa(JSON.stringify({scope,cohort,asOf,offset:offset+50})):null});
}
export async function playerAnalytics(session,env){
  const where=session.user_id?'user_id=?':'owner_session=?',identity=session.user_id||session.id;
  const cohorts=await all(env,`SELECT cohort,difficulty,opponent,mode,COUNT(*) AS games,SUM(status='complete') AS completed,
    SUM(status='void') AS voided,SUM(eligible) AS eligible,SUM(CASE WHEN eligible=1 AND result_units=2 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN eligible=1 AND result_units=1 THEN 1 ELSE 0 END) AS draws,SUM(CASE WHEN eligible=1 AND result_units=0 THEN 1 ELSE 0 END) AS losses
    FROM matches WHERE ${where} GROUP BY cohort,difficulty,opponent,mode`,identity);
  const recent=await all(env,`SELECT id,difficulty,opponent,mode,status,eligible,verification,result_units,revision,created_at,finished_at FROM matches WHERE ${where} ORDER BY created_at DESC LIMIT 100`,identity);
  return json({scope:'all owned matches for cohort totals; newest 100 for recent list',cohorts,recent});
}
