import { createInitialState,getLegalActions,getOutcome,applyAction,coords,squareAt,owner,isKing,otherSide,serialize } from './games/checkers/rules.js';
import { profileFor,features } from './games/checkers/strategy.js';
import { hashState,sha256,sealEvent,verifyReplay } from './lib/audit.js';
import { analyzeReplay,toCSV,flatEvents } from './lib/analytics.js';
import { makeZip } from './lib/zip.js';
const $=id=>document.getElementById(id),number=n=>Number.isFinite(n)?Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(n):'—';
const ms=n=>Number.isFinite(n)?n>=1000?`${(n/1000).toFixed(2)} s`:`${Math.round(n)} ms`:'—';
const moveName=id=>id?.replace(/^[mj]:/,'').replaceAll('x',' × ').replaceAll('-',' – ')||'—';
function element(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function stored(key,fallback=null){try{const data=localStorage.getItem(key);return data?JSON.parse(data):fallback;}catch{return fallback;}}
function store(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function notice(message){$('notice').textContent=message||'';$('notice').hidden=!message;}
let account=null,capabilities={jev:false,discord:false},csrfToken=null,serverOnline=false,active=null;
let opponentChosen=false; // set once the player picks an opponent, so the JEV default never overrides them
let state=createInitialState(),record=null,imported=null,busy=false,path=[],flip=true,activeTab='overview',analytics=null;
let localTurnStarted=performance.now(),localWorker=null,workerSequence=0,pollTimer=null,pollCount=0,leaderboardCursor=null,leaderboardRows=[];
const pendingWorker=new Map();
async function api(url,body){
  const start=performance.now();
  const response=await fetch(url,{credentials:'same-origin',...(body!==undefined?{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrfToken||''},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok){const error=new Error(data.error||'Request failed');error.status=response.status;error.code=data.code;throw error;}
  if(body&&url.endsWith('/actions'))telemetry('action_ack',performance.now()-start);return data;
}
function telemetry(kind,elapsedMs){
  if(!$('telemetry-consent').checked||active?.kind!=='remote'||!csrfToken)return;
  fetch('/api/telemetry',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify({matchId:active.id,consent:true,events:[{kind,elapsedMs:Math.max(0,Math.round(elapsedMs)),visible:!document.hidden}]})}).catch(()=>{});
}
function localDecision(s,difficulty){
  if(!localWorker){localWorker=new Worker('/games/checkers/local-worker.js',{type:'module'});
    localWorker.onmessage=({data})=>{const promise=pendingWorker.get(data.id);if(!promise)return;pendingWorker.delete(data.id);data.error?promise.reject(new Error(data.error)):promise.resolve(data.decision);};
    localWorker.onerror=()=>{for(const promise of pendingWorker.values())promise.reject(new Error('Local search worker failed'));pendingWorker.clear();localWorker.terminate();localWorker=null;};}
  const id=++workerSequence;return new Promise((resolve,reject)=>{pendingWorker.set(id,{resolve,reject});localWorker.postMessage({id,state:s,difficulty});});
}
function drawBoard(target,board,interactive=false){
  const focus=target.contains(document.activeElement)?document.activeElement.dataset.square:null;
  target.replaceChildren();const fragment=document.createDocumentFragment(),legal=interactive&&canMove()?getLegalActions(state):[];
  const compatible=path.length?legal.filter(a=>path.every((sq,i)=>a.path[i]===sq)):legal;
  const nextSquares=new Set(path.length?compatible.map(a=>a.path[path.length]).filter(Boolean):[]);
  const latest=record?.events.filter(e=>e.kind==='move').at(-1)?.action;
  for(let vr=0;vr<8;vr++){
    const row=element('div');row.setAttribute('role','row');
    for(let vc=0;vc<8;vc++){
      const r=flip?7-vr:vr,c=flip?7-vc:vc,sq=squareAt(r,c);
      if(!sq){const light=element('span',undefined,'square light');light.setAttribute('role','gridcell');light.setAttribute('aria-disabled','true');row.append(light);continue;}
      const p=board[sq-1],button=element(interactive?'button':'div',undefined,'square dark');
      button.dataset.square=sq;button.setAttribute('role','gridcell');
      button.setAttribute('aria-label',`Square ${sq}, ${p?`${owner(p)} ${isKing(p)?'king':'man'}`:'empty'}${path.includes(sq)&&interactive?', selected':''}${nextSquares.has(sq)?', available destination':''}`);
      if(interactive){button.tabIndex=Number(focus)===sq||(!focus&&sq===1)?0:-1;button.addEventListener('click',()=>selectSquare(sq));}
      if(interactive&&path.includes(sq))button.classList.add('selected');if(interactive&&nextSquares.has(sq))button.classList.add('next');
      if(interactive&&latest?.path.includes(sq))button.classList.add('last');
      button.append(element('span',String(sq),'number'));
      if(p){const piece=element('span',undefined,`piece ${owner(p)}${isKing(p)?' king':''}`);piece.setAttribute('aria-hidden','true');button.append(piece);}
      row.append(button);
    }fragment.append(row);
  }target.append(fragment);
  if(focus)target.querySelector(`[data-square="${focus}"]`)?.focus({preventScroll:true});
}
function currentOutcome(){return active?.outcome||getOutcome(state);}
function canMove(){return !!active&&!busy&&!currentOutcome()&&state.toMove===active.humanSide&&active.status!=='void';}
function renderGame(){
  const start=performance.now();drawBoard($('board'),state.board,true);const f=features(state),human=active?.humanSide||'red',opponent=otherSide(human);
  $('human-name').textContent=`${account?.displayName||'You'} · ${human==='red'?'Red':'White'}`;
  $('human-material').textContent=`${f[human].men+f[human].kings} pieces · ${f[human].kings} kings`;
  $('opponent-material').textContent=`${f[opponent].men+f[opponent].kings} pieces · ${f[opponent].kings} kings`;
  const remote=active?.opponent==='jev';$('opponent-name').textContent=remote?'JEV + tactical search':'Local search opponent';
  $('opponent-detail').textContent=remote?`${active.difficulty} · pinned structured opponent`:'Unranked practice · no model calls';
  $('mode-badge').textContent=active?.mode==='ranked'?'RANKED':'PRACTICE';
  const outcome=currentOutcome(),legal=getOutcome(state)?[]:getLegalActions(state);
  let status=!active?'Start a game to play.':outcome?outcome.reason==='service_failure'?'Provider unavailable · no contest':outcome.winner===null?`Draw · ${outcome.reason}`:`${outcome.winner===human?'You win':'Opponent wins'} · ${outcome.reason}`:
    busy||state.toMove!==human?remote?'JEV is evaluating…':'Local opponent is searching…':path.length>1?'Complete the capture sequence.':legal[0]?.captured.length?'Your turn · a capture is mandatory.':'Your turn · select a piece.';
  $('turn-status').textContent=status;$('resign').disabled=!canMove();$('thinking-dot').classList.toggle('busy',busy);
  $('continue-local').hidden=active?.status!=='void'||!!getOutcome(state);
  $('legal-count').textContent=String(legal.length);$('move-count').textContent=`(${legal.length})`;
  $('legal-moves').replaceChildren(...legal.map(a=>{const b=element('button',moveName(a.id));b.disabled=!canMove();b.addEventListener('click',()=>play(a.id));return b;}));
  const decision=record?.events.filter(e=>e.actor==='opponent'&&e.kind==='move').at(-1);
  $('decision-status').textContent=busy?'Evaluating legal candidates':decision?`${decision.evidence.source==='jev'?'JEV evaluation':decision.evidence.source==='forced'?'Rules-determined action':'Local search'} · completed`:'Awaiting first decision';
  if(decision){const e=decision.evidence;$('selected-action').textContent=moveName(decision.action.id);$('search-depth').textContent=number(e.completedDepth);$('decision-time').textContent=ms(e.totalMs);$('search-nodes').textContent=number(e.searchedNodes);$('legal-count').textContent=number(e.legalCount);
    const candidate=e.candidates?.find(c=>c.actionId===decision.action.id);$('factor-list').replaceChildren();
    for(const [name,value] of Object.entries(candidate?.factors||{})){const row=element('div',undefined,'factor-row');const meter=element('meter');meter.min=0;meter.max=name==='trap'?1:4;meter.value=value;meter.setAttribute('aria-label',`${name}: ${value}`);row.append(element('span',name),meter,element('span',Number(value).toFixed(2)));$('factor-list').append(row);}
    $('factor-list').append(element('p',e.source==='jev'?`Model: ${e.model}. Certainty values are not win probabilities.`:'No model call was used for this decision.','small muted'));
  }else{$('selected-action').textContent='—';$('search-depth').textContent='—';$('decision-time').textContent='—';$('search-nodes').textContent='—';}
  telemetry('board_render',performance.now()-start);
}
function selectSquare(sq){
  if(!canMove())return;const legal=getLegalActions(state);
  if(!path.length){if(legal.some(a=>a.path[0]===sq))path=[sq];else notice('Select one of your pieces with a legal move.');renderGame();return;}
  const proposed=[...path,sq],compatible=legal.filter(a=>proposed.every((n,i)=>a.path[i]===n));
  if(compatible.length){path=proposed;const complete=compatible.find(a=>a.path.length===path.length);if(complete){play(complete.id);return;}}
  else path=legal.some(a=>a.path[0]===sq)?[sq]:[];
  notice(null);renderGame();
}
async function appendLocal(kind,action=null,evidence={},actor='human'){
  const pre=state,next=kind==='move'?applyAction(state,action.id):state,previous=record.events.at(-1)?.eventHash||await sha256(record.manifest);
  const event=await sealEvent({matchId:active.id,seq:record.events.length+1,at:new Date().toISOString(),kind,actor,action,
    evidence,turnMs:performance.now()-localTurnStarted,preHash:await hashState(pre),postHash:await hashState(next)},previous);
  record.events.push(event);state=next;record.finalState=next;record.finalHash=event.eventHash;
  record.outcome=kind==='resign'?{winner:otherSide(active.humanSide),reason:'resign'}:getOutcome(next);
  active.outcome=record.outcome;active.status=record.outcome?'complete':'playing';localTurnStarted=performance.now();persistLocal();
}
function persistLocal(){
  if(active?.kind!=='local')return;
  store('jev-checkers-active',{active,record});
  if(record.outcome){const history=stored('jev-checkers-history',[]).filter(r=>r.manifest.matchId!==record.manifest.matchId);history.unshift(record);store('jev-checkers-history',history.slice(0,5));}
}
async function runLocalOpponent(){
  if(!active||active.kind!=='local'||state.toMove===active.humanSide||currentOutcome())return;
  busy=true;renderGame();const id=active.id;
  try{const decision=await localDecision(state,active.difficulty);if(active?.id!==id)return;
    const action=getLegalActions(state).find(a=>a.id===decision.actionId);if(!action)throw new Error('Local opponent returned an illegal action');
    await appendLocal('move',action,{...decision.evidence,source:'local',model:null,profileHash:record.manifest.profileHash,stateHash:await hashState(state)},'opponent');
  }catch(error){notice(error.message);}finally{if(active?.id===id){busy=false;renderGame();renderAnalytics();}}
}
async function startLocal(initial=createInitialState(),humanSide='red'){
  clearTimeout(pollTimer);imported=null;path=[];state=structuredClone(initial);flip=humanSide==='red';busy=false;
  active={id:crypto.randomUUID(),kind:'local',opponent:'local',mode:'casual',difficulty:$('difficulty').value,humanSide,status:'playing',outcome:null};
  const profile=profileFor(active.difficulty),manifest={formatVersion:1,matchId:active.id,gameId:'checkers',rulesVersion:state.rulesVersion,engineVersion:state.engineVersion,
    buildId:'browser-practice-1.0.0',initialState:structuredClone(initial),officialStart:serialize(initial)===serialize(createInitialState()),humanSide,opponent:'local',
    profile,profileHash:await sha256(profile),trust:'untrusted_client',startedAt:new Date().toISOString()};
  record={format:'jev-checkers-audit',version:1,manifest,events:[],finalState:state,finalHash:await sha256(manifest),outcome:null,verification:'local-only',eligible:false};
  localTurnStarted=performance.now();persistLocal();renderGame();renderAnalytics();await runLocalOpponent();
}
async function startGame(){
  notice(null);
  if(active&&!currentOutcome()){
    if(active.kind==='remote'){notice('Finish or resign the active server match before starting another.');return;}
    if(!confirm('Start another local game? Your current practice record will be replaced.'))return;
  }
  try{
    if($('opponent').value==='local'){await startLocal();return;}
    busy=true;renderGame();
    const result=await api('/api/matches',{gameId:'checkers',opponent:'jev',mode:$('mode').value,difficulty:$('difficulty').value,requestId:crypto.randomUUID()});
    imported=null;await acceptRemote(result);await refreshRemoteReplay();schedulePoll();
  }catch(error){busy=false;notice(error.message);renderGame();}
}
async function acceptRemote(snapshot){
  active={...snapshot,kind:'remote'};state=snapshot.state;path=[];flip=active.humanSide==='red';
  busy=['jev_pending','verifying'].includes(active.status);renderGame();
}
async function refreshRemoteReplay(){record=await api(`/api/matches/${active.id}/replay`);renderGame();renderAnalytics();}
function schedulePoll(){
  clearTimeout(pollTimer);if(active?.kind!=='remote'||!['jev_pending','verifying'].includes(active.status))return;
  const id=active.id;pollTimer=setTimeout(async()=>{
    try{const snap=await api(`/api/matches/${id}`);if(active?.id!==id)return;const changed=snap.revision!==active.revision||snap.status!==active.status;
      await acceptRemote(snap);if(changed)await refreshRemoteReplay();
      if(snap.status==='jev_pending'&&++pollCount%10===0)await api(`/api/matches/${id}/advance`,{});
    }catch(error){notice(`Connection interrupted: ${error.message}. The server match remains resumable.`);telemetry('network_retry',1000);}
    schedulePoll();
  },1000);
}
async function resumeRemote(id){try{await acceptRemote(await api(`/api/matches/${id}`));await refreshRemoteReplay();if(active.status==='jev_pending')await api(`/api/matches/${id}/advance`,{});schedulePoll();notice(null);}catch(error){notice(error.message);}}
async function play(actionId){
  if(!canMove())return;notice(null);path=[];
  if(active.kind==='remote'){
    busy=true;renderGame();
    try{const snapshot=await api(`/api/matches/${active.id}/actions`,{expectedRevision:active.revision,requestId:crypto.randomUUID(),actionId});await acceptRemote(snapshot);await refreshRemoteReplay();schedulePoll();}
    catch(error){notice(error.message);await resumeRemote(active.id);}return;
  }
  const action=getLegalActions(state).find(a=>a.id===actionId);if(!action)return;
  busy=true;
  try{await appendLocal('move',action,{features:features(state)},'human');busy=false;renderGame();renderAnalytics();await runLocalOpponent();}
  catch(error){notice(error.message);busy=false;renderGame();}
}
async function resign(){
  if(!canMove()||!confirm('Resign this game? Ranked resignation counts as a loss.'))return;
  try{if(active.kind==='remote'){await acceptRemote(await api(`/api/matches/${active.id}/actions`,{expectedRevision:active.revision,requestId:crypto.randomUUID(),resign:true}));await refreshRemoteReplay();}
    else{await appendLocal('resign',null,{},'human');renderGame();renderAnalytics();}}
  catch(error){notice(error.message);}
}
function table(target,headers,rows){
  target.replaceChildren();if(!rows.length){target.append(element('p','No records yet.','small muted'));return;}
  const t=element('table'),head=element('thead'),hr=element('tr');headers.forEach(h=>hr.append(element('th',h)));head.append(hr);t.append(head);
  const body=element('tbody');for(const row of rows){const tr=element('tr');if(row.selected)tr.className='selected';for(const cell of row.cells||row){const td=element('td');if(cell instanceof Node)td.append(cell);else td.textContent=cell??'—';tr.append(td);}body.append(tr);}t.append(body);target.append(t);
}
const svgNS='http://www.w3.org/2000/svg';
function svgNode(tag,attributes={},text){const e=document.createElementNS(svgNS,tag);for(const [k,v]of Object.entries(attributes))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;}
function chart(target,series,label,bars=false){
  target.replaceChildren();const values=series.flatMap(s=>s.values).filter(Number.isFinite);
  if(!values.length){target.append(element('div','Metrics appear as the game progresses.','empty-chart'));return;}
  const svg=svgNode('svg',{viewBox:'0 0 500 180',role:'img','aria-label':label});svg.append(svgNode('title',{},label));
  let min=Math.min(0,...values),max=Math.max(1,...values);if(min===max)max=min+1;
  const width=445,height=125,left=42,top=12,y=v=>top+height-(v-min)/(max-min)*height;
  for(let i=0;i<4;i++){const value=min+(max-min)*i/3;svg.append(svgNode('line',{x1:left,x2:left+width,y1:y(value),y2:y(value),class:'grid-line'}),svgNode('text',{x:3,y:y(value)+3},number(value)));}
  for(const [s,entry]of series.entries()){
    const n=entry.values.length,x=i=>left+(n>1?i/(n-1):.5)*width;
    if(bars){const step=width/Math.max(1,n);entry.values.forEach((v,i)=>{const bar=svgNode('rect',{x:left+i*step+2,y:y(v),width:Math.max(1,step-4),height:Math.max(1,y(0)-y(v)),class:'bar'});bar.append(svgNode('title',{},`${entry.name} ${i+1}: ${number(v)}`));svg.append(bar);});}
    else{const p=entry.values.map((v,i)=>`${i?'L':'M'}${x(i)},${y(v)}`).join(' ');svg.append(svgNode('path',{d:p,class:`chart-line${s?' secondary':''}`}));if(n===1)svg.append(svgNode('circle',{cx:x(0),cy:y(entry.values[0]),r:3,class:'bar'}));}
    svg.append(svgNode('text',{x:left+s*190,y:166},`${entry.name} · ${entry.values.length} observations`));
  }target.append(svg);
}
function renderAnalytics(){
  const r=imported||record;
  if(!r){$('audit-status').textContent='No match recorded yet. Local records are untrusted; official scores require server verification.';return;}
  analytics=analyzeReplay(r);const a=analytics;
  $('audit-status').textContent=`${imported?'Imported record':r.manifest.trust==='trusted_server'?'Server-recorded match':'Local practice · untrusted client'} · ${r.events.length} events · ${r.verification||'not verified'} · profile ${r.manifest.profileHash.slice(0,12)}…`;
  $('metric-turns').textContent=number(a.turns);$('metric-captures').textContent=`${a.bySide.red.captures+a.bySide.white.captures} captures · ${a.bySide.red.promotions+a.bySide.white.promotions} promotions`;
  $('metric-latency').textContent=ms(a.timing.opponent.p50);$('metric-p95').textContent=`p95 ${ms(a.timing.opponent.p95)}`;
  $('metric-calls').textContent=number(a.jev.decisions);$('metric-tokens').textContent=a.jev.calls?`${number(a.jev.inputTokens)} input tokens · ${a.jev.calls} attempts`:'No provider usage';
  $('metric-changed').textContent=a.jev.changedRate===null?'—':`${(100*a.jev.changedRate).toFixed(1)}%`;
  chart($('material-chart'),[{name:'Red − White',values:a.points.map(p=>p.materialBalance)}],'Material balance over all recorded positions');
  chart($('latency-chart'),[{name:'Opponent latency (ms)',values:a.moves.filter(m=>m.actor==='opponent').map(m=>m.totalMs).filter(Number.isFinite)}],'Opponent decision latency in milliseconds',true);
  chart($('mobility-chart'),[{name:'Red mobility',values:a.points.map(p=>p.redMobility)},{name:'White mobility',values:a.points.map(p=>p.whiteMobility)}],'Red and white legal moves over all recorded positions');
  const heat=$('heatmap'),max=Math.max(1,...a.heatmaps.landings);heat.replaceChildren();
  for(let row=0;row<8;row++)for(let col=0;col<8;col++){const sq=squareAt(row,col),count=sq?a.heatmaps.landings[sq-1]:0,cell=element('div',sq?String(count):'',`heat-cell ${sq?`heat-${count?Math.max(1,Math.ceil(count/max*5)):0}`:'blank'}`);if(sq){cell.title=`Square ${sq}: ${count} landings`;cell.setAttribute('aria-label',cell.title);}heat.append(cell);}
  const metricRows=[];
  function flatten(obj,prefix=''){for(const [key,value]of Object.entries(obj)){if(Array.isArray(value))continue;const path=prefix?`${prefix}.${key}`:key;if(value&&typeof value==='object')flatten(value,path);else metricRows.push([path,typeof value==='number'?number(value):value===null?'Unknown / not applicable':String(value)]);}}
  flatten({bySide:a.bySide,byPhase:a.byPhase,sources:a.sourceCounts,timing:a.timing,search:a.search,jev:a.jev});table($('metrics-table'),['Metric','Value'],metricRows);
  const select=$('decision-select'),previous=select.value;select.replaceChildren();
  for(const event of r.events.filter(e=>e.actor==='opponent'&&e.kind==='move')){const option=element('option',`Turn ${event.seq} · ${moveName(event.action.id)}`);option.value=event.seq;select.append(option);}
  select.value=[...select.options].some(o=>o.value===previous)?previous:select.options[select.options.length-1]?.value||'';
  renderDecision();$('replay-slider').max=r.events.length;renderReplay();renderEvents();
}
function renderDecision(){
  const event=(imported||record)?.events.find(e=>e.seq===Number($('decision-select').value));
  if(!event){table($('candidate-table'),[],[]);$('raw-decision').textContent='No opponent decisions yet.';return;}
  table($('candidate-table'),['Rank','Move','Search','JEV Δ','Utility','Promotion','Mobility','Support','Trap'],(event.evidence.candidates||[]).map((c,i)=>({selected:c.actionId===event.action.id,cells:[i+1,`${c.actionId===event.action.id?'✓ ':''}${moveName(c.actionId)}`,number(c.tacticalScore),number(c.adjustment),number(c.utility),number(c.factors?.promotion),number(c.factors?.mobility),number(c.factors?.support),number(c.factors?.trap)]})));
  $('raw-decision').textContent=JSON.stringify(event.evidence,null,2);
}
function renderReplay(){
  const r=imported||record;if(!r)return;const index=Math.min(Number($('replay-slider').value),r.events.length);let s=structuredClone(r.manifest.initialState||createInitialState());
  for(const e of r.events.slice(0,index))if(e.kind==='move')s=applyAction(s,e.action.id);
  drawBoard($('replay-board'),s.board);$('replay-label').textContent=`Event ${index} / ${r.events.length}`;
  const e=r.events[index-1];$('replay-description').textContent=e?`${e.actor}: ${e.action?moveName(e.action.id):e.kind}`:'Initial position';
  $('replay-state').textContent=JSON.stringify({toMove:s.toMove,ply:s.ply,noProgressPly:s.noProgressPly,board:s.board},null,2);
}
function renderEvents(){
  const r=imported||record;if(!r)return;const filter=$('event-filter').value.toLowerCase();
  const rows=r.events.filter(e=>`${e.seq} ${e.actor} ${e.kind} ${e.action?.id||''}`.toLowerCase().includes(filter)).map(e=>[e.seq,e.kind,e.actor,e.action?.id||'—',e.evidence?.source||'—',`${e.eventHash.slice(0,16)}…`,e.at]);
  table($('events-table'),['#','Event','Actor','Action','Source','Event hash','Timestamp'],rows);
}
async function verify(){try{const r=imported||record;if(!r)throw new Error('Start or import a game first.');const checked=await verifyReplay(r);$('audit-status').textContent=`Integrity verified · ${checked.eventCount} events · ${checked.finalHash.slice(0,20)}… · ${checked.trust}`;notice(null);}catch(error){notice(`Verification failed: ${error.message}`);}}
async function collectOperations(){
  if(imported||active?.kind!=='remote')return [];
  let cursor=null,entries=[];
  do{const q=cursor?`?after=${cursor.after}&afterId=${encodeURIComponent(cursor.afterId)}`:'';const page=await api(`/api/matches/${active.id}/operations${q}`);entries.push(...page.entries);cursor=page.next;}while(cursor);return entries;
}
async function exportAnalytics(){
  const r=imported||record;if(!r){notice('Start or import a game before exporting analytics.');return;}
  $('export').disabled=true;
  try{
    const verified=await verifyReplay(r),a=analyzeReplay(r),operations=await collectOperations(),summary={...a};delete summary.points;delete summary.moves;delete summary.candidates;
    const exportManifest={exportVersion:1,generatedAt:new Date().toISOString(),matchId:r.manifest.matchId,profileHash:r.manifest.profileHash,
      trust:r.manifest.trust,integrityCheck:{valid:verified.valid,eventCount:verified.eventCount,finalHash:verified.finalHash},
      operationCount:operations.length,notes:a.notes};
    const files={'replay.json':JSON.stringify(r,null,2),'summary.json':JSON.stringify(summary,null,2),'manifest.json':JSON.stringify(exportManifest,null,2),
      'moves.csv':toCSV(a.moves),'candidates.csv':toCSV(a.candidates),'positions.csv':toCSV(a.points),'events.csv':toCSV(flatEvents(r)),
      'events.ndjson':r.events.map(e=>JSON.stringify(e)).join('\n')+'\n','operations.ndjson':operations.map(e=>JSON.stringify(e)).join('\n')+'\n',
      'heatmaps.json':JSON.stringify(a.heatmaps,null,2),
      'README.txt':'JEV Checkers analytics export\nAll recorded turns, with no sampling.\nVerify replay.json using the source package: npm run verify -- replay.json\nCSV string fields are escaped against spreadsheet formula injection.\nTrust: hash integrity is not a signature or proof of official score provenance.\nHuman elapsed time may include network delay and time away.\nProvider certainty and heuristic values are not win probabilities.\nMissing usage/cost stays unknown. Operations are available only for owned server records.\n'};
    const blob=makeZip(files),url=URL.createObjectURL(blob),link=element('a');link.href=url;link.download=`checkers-analytics-${r.manifest.matchId}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice(null);
  }catch(error){notice(`Export failed: ${error.message}`);}finally{$('export').disabled=false;}
}
async function importReplay(file){
  if(!file)return;
  try{if(file.size>25*1024*1024)throw new Error('Replay file exceeds 25 MB.');const r=JSON.parse(await file.text());await verifyReplay(r);imported=r;renderAnalytics();showTab('replay');notice('Imported record is read-only and unofficial. Your live game was not changed.');}
  catch(error){notice(`Replay rejected: ${error.message}`);}finally{$('import-replay').value='';}
}
async function loadLeaderboard(more=false){
  if(!serverOnline){table($('leaderboard-table'),[],[]);notice('Leaderboards require the backend and verified Discord games.');return;}
  try{const scope=$('leaderboard-scope').value,difficulty=$('difficulty').value;const result=await api(`/api/leaderboard?scope=${scope}&difficulty=${difficulty}${more&&leaderboardCursor?`&cursor=${encodeURIComponent(leaderboardCursor)}`:''}`);
    leaderboardRows=more?[...leaderboardRows,...result.entries]:result.entries;leaderboardCursor=result.nextCursor;
    table($('leaderboard-table'),['Rank','Player','Balanced %','W','D','L','Games','Streak'],leaderboardRows.map(r=>[r.provisional?'Provisional':r.rank,r.name,number(r.balancedScore),r.wins,r.draws,r.losses,r.games,r.currentStreak]));$('leaderboard-more').hidden=!leaderboardCursor;
  }catch(error){notice(error.message);}
}
async function loadHistory(){
  const local=stored('jev-checkers-history',[]),rows=[];
  for(const r of local){const b=element('button','Inspect');b.onclick=()=>{imported=r;renderAnalytics();showTab('replay');};rows.push(['Local practice',r.manifest.profile.difficulty,r.outcome?.reason||'unfinished',r.events.length,b]);}
  if(serverOnline)try{const data=await api('/api/analytics/me');for(const m of data.recent){const b=element('button','Inspect');b.onclick=async()=>{try{imported=await api(`/api/matches/${m.id}/replay`);renderAnalytics();showTab('replay');}catch(e){notice(e.message);}};rows.push([`${m.opponent} · ${m.mode}`,m.difficulty,m.status,m.revision,b]);}}catch(error){notice(error.message);}
  table($('history-table'),['Source','Difficulty','Status','Events','Record'],rows);
}
function showTab(name){activeTab=name;for(const tab of document.querySelectorAll('[data-tab]')){const selected=tab.dataset.tab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$(`${tab.dataset.tab}-panel`).hidden=!selected;}
  if(name==='leaderboard')loadLeaderboard();if(name==='history')loadHistory();}
function applyCapabilities(){
  $('opponent').querySelector('[value=jev]').disabled=!capabilities.jev;$('opponent').querySelector('[value=jev]').textContent=capabilities.jev?'JEV · structured model + search':'JEV · connect API to enable';
  // Default to JEV once the server reports it available. The <option> order puts
  // local first, so without this the select stays on the local search opponent
  // even while the header reads "JEV CONNECTED". Applied once, and never over a
  // choice the player has already made.
  if(capabilities.jev&&!opponentChosen&&$('opponent').value!=='jev'){$('opponent').value='jev';opponentChosen=true;}
  $('mode').querySelector('[value=ranked]').disabled=!account||!capabilities.jev||$('opponent').value!=='jev';
  if($('mode').querySelector('[value=ranked]').disabled)$('mode').value='casual';
  $('login').hidden=!capabilities.discord||!!account;$('logout').hidden=!account;$('identity').textContent=account?.displayName||'Guest';
}
async function bootstrap(){
  const launch=new URL(location.href).searchParams.get('launch');
  if(launch&&/^[a-f0-9]{64}$/.test(launch)){sessionStorage.setItem('checkers-launch',launch);history.replaceState(null,'',location.pathname);}
  $('analysis-on').checked=stored('jev-analysis-on',true);$('decision-body').hidden=!$('analysis-on').checked;
  $('telemetry-consent').checked=stored('jev-telemetry-consent',false);$('difficulty').value=stored('jev-difficulty','jev');
  if(!['easy','normal','hard','jev'].includes($('difficulty').value))$('difficulty').value='jev';
  try{
    const result=await api('/api/me');serverOnline=true;account=result.user;csrfToken=result.csrf;capabilities=result.capabilities;
    $('connection').textContent=capabilities.jev?'JEV CONNECTED':'LOCAL READY';
    if(result.activeMatchId){$('resume').hidden=false;$('resume').onclick=()=>resumeRemote(result.activeMatchId);}
    const pending=sessionStorage.getItem('checkers-launch');
    if(pending&&account){try{await api('/api/launch/redeem',{token:pending});sessionStorage.removeItem('checkers-launch');notice('Discord channel context verified. Your next ranked match can count for Channel, Server and World.');}catch(error){sessionStorage.removeItem('checkers-launch');notice(error.message);}}
    else if(pending)notice('Sign in with the Discord account that invoked /play checkers to redeem this launch.');
  }catch{$('connection').textContent='LOCAL ONLY';}
  applyCapabilities();renderGame();
  const saved=stored('jev-checkers-active');
  if(saved?.record&&!saved.record.outcome&&saved.active?.kind==='local'){
    try{await verifyReplay(saved.record);active=saved.active;record=saved.record;state=record.finalState;localTurnStarted=performance.now();renderGame();renderAnalytics();await runLocalOpponent();}catch{store('jev-checkers-active',null);}
  }
}
$('new-game').onclick=startGame;$('resign').onclick=resign;$('flip').onclick=()=>{flip=!flip;renderGame();renderReplay();};
$('cancel-selection').onclick=()=>{path=[];renderGame();};$('continue-local').onclick=()=>startLocal(state,active.humanSide);
$('analysis-on').onchange=()=>{$('decision-body').hidden=!$('analysis-on').checked;store('jev-analysis-on',$('analysis-on').checked);};
$('difficulty').onchange=()=>{store('jev-difficulty',$('difficulty').value);if(activeTab==='leaderboard')loadLeaderboard();};
$('opponent').onchange=()=>{opponentChosen=true;applyCapabilities();};$('telemetry-consent').onchange=()=>store('jev-telemetry-consent',$('telemetry-consent').checked);
$('logout').onclick=async()=>{try{await api('/api/logout',{});location.reload();}catch(error){notice(error.message);}};
$('board').addEventListener('keydown',event=>{
  if(event.key==='Escape'){path=[];renderGame();return;}
  const directions={ArrowLeft:-1,ArrowRight:1,ArrowUp:-4,ArrowDown:4};if(!(event.key in directions))return;
  event.preventDefault();const buttons=[...$('board').querySelectorAll('button')],i=buttons.indexOf(document.activeElement),next=buttons[Math.max(0,Math.min(buttons.length-1,i+directions[event.key]))];
  buttons.forEach(b=>b.tabIndex=-1);next.tabIndex=0;next.focus();
});
for(const tab of document.querySelectorAll('[data-tab]')){tab.onclick=()=>showTab(tab.dataset.tab);tab.onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-tab]')],i=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;showTab(tabs[next].dataset.tab);tabs[next].focus();};}
$('decision-select').onchange=renderDecision;$('replay-slider').oninput=renderReplay;$('event-filter').oninput=renderEvents;
$('verify').onclick=verify;$('export').onclick=exportAnalytics;$('import-replay').onchange=()=>importReplay($('import-replay').files[0]);
$('refresh-leaderboard').onclick=()=>loadLeaderboard();$('leaderboard-scope').onchange=()=>loadLeaderboard();$('leaderboard-more').onclick=()=>loadLeaderboard(true);$('refresh-history').onclick=loadHistory;
document.addEventListener('visibilitychange',()=>telemetry('visibility_change',performance.now()));
bootstrap();
