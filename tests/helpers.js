import { readFile } from 'node:fs/promises';
import { NodeDB } from '../server/node-db.js';
import worker from '../server/worker.js';
import { createInitialState,positionKey } from '../public/games/checkers/rules.js';
export function position(pieces,toMove='red',ply=0,noProgressPly=0){
  const state={...createInitialState(),board:Array(32).fill(0),toMove,ply,noProgressPly,repetitions:{}};
  for(const [sq,piece]of Object.entries(pieces))state.board[Number(sq)-1]=piece;
  state.repetitions[positionKey(state)]=1;return state;
}
export async function testEnv(extra={}){
  const DB=new NodeDB();DB.exec(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));
  const env={DB,APP_ENV:'local',APP_ORIGIN:'http://127.0.0.1:8787',ASSETS:{fetch:()=>new Response('static')},...extra};
  const tasks=[];const ctx={waitUntil(p){tasks.push(p);}};
  return {env,ctx,DB,async drain(){while(tasks.length)await tasks.shift();}};
}
export async function client(environment){
  let cookie='',csrf='';
  return {get cookie(){return cookie;},get csrf(){return csrf;},
    async request(path,{method='GET',body,headers={},origin='http://127.0.0.1:8787',raw}={}){
      const request=new Request(`http://127.0.0.1:8787${path}`,{method,headers:{cookie,...(method==='POST'?{'content-type':'application/json','x-csrf-token':csrf,origin}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:raw!==undefined?{body:raw}:{})});
      const response=await worker.fetch(request,environment.env,environment.ctx);
      const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
      let data;try{data=await response.clone().json();}catch{data=null;}
      if(path==='/api/me'&&data?.csrf)csrf=data.csrf;
      return {response,data,status:response.status};
    }
  };
}
// Mirrors the provider's real output grain: probabilities and expected scores rounded to 0.01, so the
// bucket sum and the expected score only agree with the distribution to within that rounding.
export function roundedJev(request){
  const answers={};
  for(const [key,q]of Object.entries(request.questions)){
    if(q.type==='noul'){answers[key]={type:'noul',noul:.2};continue;}
    const raw=[.084,.337,.229,.298,.052].slice(0,q.criteria.length);
    const probabilities=Object.fromEntries(raw.map((p,i)=>[String(i),Math.round(p*100)/100]));
    const mean=raw.reduce((t,p,i)=>t+i*p,0);
    answers[key]={type:'score',score:Math.round(mean*100)/100,confidence:.11,
      probabilities,legend:Object.fromEntries(q.criteria.map((text,i)=>[String(i),text]))};
  }
  return {model:request.model,answers,usage:{input_tokens:5753,output_tokens:347}};
}
export function mockJev(request,score=2){
  const answers={};
  for(const [key,q]of Object.entries(request.questions))answers[key]=q.type==='noul'?{type:'noul',noul:.2}:{type:'score',score,confidence:1,
    probabilities:Object.fromEntries(q.criteria.map((_,i)=>[String(i),i===score?1:0])),legend:Object.fromEntries(q.criteria.map((text,i)=>[String(i),text]))};
  return {model:request.model,answers,usage:{input_tokens:100,output_tokens:20}};
}
