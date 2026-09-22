import { profileFor, searchCandidates, searchEvidence, rankCandidates, features } from '../public/games/checkers/strategy.js';
import { hashState, sha256 } from '../public/lib/audit.js';
import { operation, uid, HttpError } from './util.js';
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Smallest increment the provider reports Score probabilities and expected scores on.
export const PROBABILITY_GRAIN = 0.01;
const RUBRICS = {
  promotion: ['Much worse promotion prospects','Worse promotion prospects','Balanced promotion prospects','Better promotion prospects','Much better promotion prospects'],
  mobility: ['Severely confined relative to the opponent','Worse useful mobility','Balanced useful mobility','Better useful mobility','Strong durable mobility advantage'],
  support: ['Severely vulnerable piece structure','Worse piece support','Balanced piece support','Better piece support','Strong resilient piece structure']
};
export function buildRequest(state,search,profile) {
  const candidates=search.candidates.map(c=>({actionId:c.action.id,path:c.action.path,afterBoard:c.after.board,
    features:features(c.after),frontierBoard:c.frontierBoard,searchDepth:search.completedDepth,horizonLimited:true}));
  const packet={rules:{id:state.rulesVersion,numbering:'Playable squares 1-32, row-major. Red moves toward increasing rows.',
    pieces:{0:'empty',1:'red man',2:'red king',3:'white man',4:'white king'},
    movement:'Men move and capture forward only. Kings one square diagonally or short jumps in both directions. Capture mandatory; no longest-chain rule. Crowning ends turn.'},
    perspective:state.toMove,currentBoard:state.board,noProgressPly:state.noProgressPly,candidates};
  const questions={};
  for(let i=0;i<candidates.length;i++)for(const factor of profile.factors){
    const instruction=`Evaluate state.candidates[${i}] from state.perspective. `+
      `Assess ${factor==='trap'?'whether an unresolved tactical trap makes this move vulnerable beyond the searched horizon':factor==='promotion'?'relative future king-making prospects':factor==='mobility'?'useful mobility and resistance to confinement':'cohesion and resilience of the piece structure'}. `+
      'Use the supplied exact board features. Search frontiers are horizon-limited, not proven game outcomes. Answer independently of all other questions.';
    questions[`c${i}_${factor}`]=factor==='trap'?{type:'noul',instructions:instruction,criteria:{true:'Meaningful unresolved tactical vulnerability',false:'No meaningful unresolved vulnerability apparent'}}:
      {type:'score',instructions:instruction,criteria:RUBRICS[factor]};
  }
  const request={model:profile.model,state:packet,questions};
  if(new TextEncoder().encode(JSON.stringify(packet)).length>28000 || new TextEncoder().encode(JSON.stringify(request)).length>60000)
    throw new HttpError(503,'JEV request exceeds the application context budget','context_budget');
  return request;
}
export function validateAnswers(response,request) {
  if(!response || response.model!==request.model || !response.answers || typeof response.answers!=='object')throw new Error('Model or answer map mismatch');
  const expected=Object.keys(request.questions).sort(),actual=Object.keys(response.answers).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('Answer keys mismatch');
  const numbers=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
  const normalized={};
  for(const key of expected){
    const q=request.questions[key],a=response.answers[key];
    if(!a || a.type!==q.type)throw new Error('Answer type mismatch');
    if(q.type==='noul'){
      if(!numbers(a.noul,0,1))throw new Error('Invalid noul');
      normalized[key]={type:'noul',noul:a.noul};
    }else{
      const n=q.criteria.length,ks=Array.from({length:n},(_,i)=>String(i));
      if(!numbers(a.score,0,n-1)||!numbers(a.confidence,0,1)||!a.probabilities||!a.legend)throw new Error('Invalid score');
      if(JSON.stringify(Object.keys(a.probabilities).sort())!==JSON.stringify(ks)||JSON.stringify(Object.keys(a.legend).sort())!==JSON.stringify(ks))throw new Error('Invalid score keys');
      let total=0,mean=0;
      for(const k of ks){const p=a.probabilities[k];if(!numbers(p,0,1)||a.legend[k]!==q.criteria[Number(k)])throw new Error('Invalid score distribution or legend');total+=p;mean+=Number(k)*p;}
      // The provider reports probabilities and scores on a 0.01 grain, so each bucket may be off by half a
      // grain. Tolerances are the worst-case accumulation of that rounding, not slack for arbitrary drift.
      const half=PROBABILITY_GRAIN/2,sumTolerance=n*half,meanTolerance=half*(n*(n-1)/2)+half;
      if(Math.abs(total-1)>sumTolerance||Math.abs(mean-a.score)>meanTolerance)throw new Error('Inconsistent score distribution');
      normalized[key]={type:'score',score:a.score,confidence:a.confidence,probabilities:a.probabilities,legend:a.legend};
    }
  }
  if(!response.usage||!Number.isSafeInteger(response.usage.input_tokens)||response.usage.input_tokens<0||!Number.isSafeInteger(response.usage.output_tokens)||response.usage.output_tokens<0)throw new Error('Invalid token usage');
  return {answers:normalized,usage:{input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens},model:response.model};
}
export function factorsFromAnswers(search,profile,answers){
  const byAction={};
  search.candidates.forEach((c,i)=>{byAction[c.action.id]={};for(const factor of profile.factors){const a=answers[`c${i}_${factor}`];byAction[c.action.id][factor]=a.type==='noul'?a.noul:a.score;}});
  return byAction;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function chooseJevAction(state,difficulty,env,{matchId=null,profile=profileFor(difficulty)}={}){
  const started=performance.now(),decisionId=uid(),search=searchCandidates(state,profile),stateHash=await hashState(state),profileHash=await sha256(profile);
  if(search.forced||search.tacticalWin){
    return {actionId:search.candidates[0].action.id,source:'forced',model:null,evidence:{...searchEvidence(search),
      reason:search.forced?'only-legal-action':'immediate-terminal-win',decisionId,stateHash,profileHash,
      totalMs:performance.now()-started,providerMs:0,questionCount:0,attempts:[],usage:null,changedFromBaseline:false}};
  }
  if(!env.TYPESAFE_API_KEY)throw new HttpError(503,'JEV is not configured','jev_not_configured');
  const request=buildRequest(state,search,profile),requestHash=await sha256(request),attempts=[];
  await operation(env,'jev_request_prepared',{decisionId,stateHash,profileHash,requestHash,request,
    search:searchEvidence(search)},matchId,decisionId);
  const providerStart=performance.now(),deadline=providerStart+8000;
  let result,lastCode='jev_unavailable';
  for(let attempt=1;attempt<=2;attempt++){
    const remaining=deadline-performance.now();if(remaining<=100)break;
    const t=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
    let statusCode=null,retryDelay=200;
    try{
      await operation(env,'jev_attempt_started',{decisionId,attempt,requestHash},matchId,decisionId);
      const response=await (env.FETCH||fetch)(ENDPOINT,{method:'POST',headers:{authorization:`Bearer ${env.TYPESAFE_API_KEY}`,'content-type':'application/json'},body:JSON.stringify(request),signal:controller.signal});
      statusCode=response.status;
      const retry=response.headers.get('retry-after');
      if(retry){const seconds=Number(retry);const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now();if(Number.isFinite(delay))retryDelay=Math.max(200,delay);}
      if(!response.ok){
        await response.body?.cancel();
        lastCode=`provider_http_${response.status}`;
        const error=new Error('Provider HTTP failure');error.retryable=[429,529,500,502,503,504].includes(response.status);throw error;
      }
      const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw new Error('Provider payload too large');}text+=decoder.decode(value,{stream:true});}
      text+=decoder.decode();
      result=validateAnswers(JSON.parse(text),request);
      const record={attempt,status:'ok',httpStatus:statusCode,latencyMs:performance.now()-t,usage:result.usage};attempts.push(record);
      await operation(env,'jev_response_validated',{decisionId,requestHash,attempt:record,response:result},matchId,decisionId);break;
    }catch(error){
      lastCode=controller.signal.aborted?'provider_timeout':statusCode===200?'invalid_provider_response':lastCode;
      const record={attempt,status:lastCode,httpStatus:statusCode,latencyMs:performance.now()-t,usage:null};attempts.push(record);
      await operation(env,'jev_attempt_failed',{decisionId,requestHash,attempt:record},matchId,decisionId);
      if(error.retryable===false||performance.now()+retryDelay>=deadline||attempt===2)break;
      await sleep(retryDelay);
    }finally{clearTimeout(timer);}
  }
  if(!result){const error=new HttpError(503,'JEV could not complete this turn. The match will not count as a loss.','jev_failed');error.evidence={decisionId,stateHash,profileHash,requestHash,attempts,providerMs:performance.now()-providerStart,totalMs:performance.now()-started,failureCode:lastCode};throw error;}
  const ranked=rankCandidates(search,factorsFromAnswers(search,profile,result.answers),profile);
  return {actionId:ranked[0].action.id,source:'jev',model:result.model,evidence:{...searchEvidence(search,ranked),
    decisionId,stateHash,profileHash,requestHash,answers:result.answers,usage:result.usage,
    questionCount:Object.keys(request.questions).length,requestBytes:new TextEncoder().encode(JSON.stringify(request)).length,
    attempts,totalMs:performance.now()-started,providerMs:performance.now()-providerStart,
    changedFromBaseline:ranked[0].action.id!==search.candidates[0].action.id}};
}
