import { createInitialState, applyAction, owner, isKing } from '../games/checkers/rules.js';
import { features, evaluate } from '../games/checkers/strategy.js';
export const ANALYTICS_VERSION = 'analytics-1.0.0';
const sum = a => a.reduce((s,x) => s+x,0);
export function distribution(values) {
  const a = values.filter(x => Number.isFinite(x)).sort((a,b) => a-b);
  const q = p => { if (!a.length) return null; const i=(a.length-1)*p, lo=Math.floor(i); return a[lo]+(a[Math.ceil(i)]-a[lo])*(i-lo); };
  return { count: a.length, sum: sum(a), min: a[0] ?? null, max: a.at(-1) ?? null,
    mean: a.length ? sum(a)/a.length : null, p50: q(.5), p90: q(.9), p95: q(.95), p99: q(.99) };
}
const ratio = (a,b) => b ? a/b : null;
/** Derives metrics from every recorded turn. Never estimates unavailable provider usage. */
export function analyzeReplay(replay) {
  let state = replay.manifest.initialState || createInitialState();
  const points=[], moves=[], candidates=[], latencies=[], humanTimes=[], providerTimes=[], searches=[], regrets=[];
  const nodes=[], depths=[], legalCounts=[], coverage=[], confidence=[], entropies=[];
  const occupancy = { red: Array(32).fill(0), white: Array(32).fill(0) }, landings=Array(32).fill(0), capturesAt=Array(32).fill(0);
  const bySide = Object.fromEntries(['red','white'].map(s => [s,{ moves:0,captures:0,captureTurns:0,multiJumps:0,promotions:0,kingMoves:0,maxCapture:0 }]));
  const byPhase = { opening:0,middlegame:0,endgame:0 }, sourceCounts={ human:0,jev:0,forced:0,local:0 };
  let serviceFailures=0, calls=0, retries=0, failures=0, inputTokens=0, outputTokens=0, usageKnown=0, unknownUsageCalls=0, changed=0, exhausted=0, pruned=0;
  function snapshot(seq) {
    const f=features(state);
    for (let i=0;i<32;i++) { const side=owner(state.board[i]); if(side) occupancy[side][i]++; }
    points.push({seq,ply:state.ply,redMaterial:f.red.material,whiteMaterial:f.white.material,
      materialBalance:f.red.material-f.white.material,heuristicBalance:evaluate(state,'red'),redMobility:f.red.mobility,
      whiteMobility:f.white.mobility,redKings:f.red.kings,whiteKings:f.white.kings,phase:f.phase,
      noProgressPly:state.noProgressPly,features:f});
  }
  snapshot(0);
  for (const event of replay.events) {
    const e=event.evidence || {}, attempts=e.attempts||[];
    calls+=attempts.length; retries+=Math.max(0,attempts.length-1);
    failures+=attempts.filter(a=>a.status!=='ok').length;
    for(const attempt of attempts) {
      if(attempt.usage && Number.isFinite(attempt.usage.input_tokens) && Number.isFinite(attempt.usage.output_tokens)) {
        inputTokens+=attempt.usage.input_tokens;outputTokens+=attempt.usage.output_tokens;usageKnown++;
      } else unknownUsageCalls++;
    }
    if (event.kind !== 'move') {
      if(event.kind==='service_failure') {serviceFailures++;if(Number.isFinite(e.totalMs))latencies.push(e.totalMs);if(Number.isFinite(e.providerMs))providerTimes.push(e.providerMs);}
      continue;
    }
    const before=state, side=state.toMove, action=event.action, phase=features(state).phase;
    state=applyAction(state,action.id); const f=features(state), sideStats=bySide[side];
    sideStats.moves++; sideStats.captures+=action.captured.length; sideStats.captureTurns+=Number(action.captured.length>0);
    sideStats.multiJumps+=Number(action.captured.length>1); sideStats.promotions+=Number(action.promotes);
    sideStats.kingMoves+=Number(isKing(before.board[action.path[0]-1])); sideStats.maxCapture=Math.max(sideStats.maxCapture,action.captured.length);
    byPhase[phase]++; sourceCounts[event.actor==='human'?'human':e.source]=(sourceCounts[event.actor==='human'?'human':e.source]||0)+1;
    landings[action.path.at(-1)-1]++; action.captured.forEach(sq=>capturesAt[sq-1]++);
    if (event.actor==='human' && Number.isFinite(event.turnMs)) humanTimes.push(event.turnMs);
    if (event.actor==='opponent') {
      if(Number.isFinite(e.totalMs)) latencies.push(e.totalMs);
      if(Number.isFinite(e.providerMs)) providerTimes.push(e.providerMs);
      if(Number.isFinite(e.searchMs)) searches.push(e.searchMs);
      if(Number.isFinite(e.searchedNodes)) nodes.push(e.searchedNodes);
      if(Number.isFinite(e.completedDepth)) depths.push(e.completedDepth);
      if(Number.isFinite(e.legalCount)) legalCounts.push(e.legalCount);
      if(e.legalCount) coverage.push((e.evaluatedCount||0)/e.legalCount);
      exhausted+=Number(!!e.budgetExhausted); pruned+=e.prunedCount||0; changed+=Number(!!e.changedFromBaseline);
      const selected=(e.candidates||[]).find(c=>c.actionId===action.id);
      if(selected) regrets.push(Math.max(0,Math.max(...e.candidates.map(c=>c.tacticalScore))-selected.tacticalScore));
      for(const [key,a] of Object.entries(e.answers||{})) {
        if(Number.isFinite(a.confidence)) confidence.push(a.confidence);
        if(a.probabilities) { const ps=Object.values(a.probabilities); entropies.push(-sum(ps.filter(p=>p>0).map(p=>p*Math.log2(p)))); }
      }
      for(const [rank,c] of (e.candidates||[]).entries()) candidates.push({seq:event.seq,ply:state.ply,rank:rank+1,selected:c.actionId===action.id,
        actionId:c.actionId,tacticalScore:c.tacticalScore,jevAdjustment:c.adjustment,utility:c.utility,
        promotion:c.factors?.promotion??null,mobility:c.factors?.mobility??null,support:c.factors?.support??null,trap:c.factors?.trap??null});
    }
    moves.push({seq:event.seq,ply:state.ply,side,actor:event.actor,actionId:action.id,source:e.source||'human',phase,
      captures:action.captured.length,promotes:action.promotes,turnMs:event.turnMs??null,totalMs:e.totalMs??null,
      providerMs:e.providerMs??null,searchMs:e.searchMs??null,legalCount:e.legalCount??null,evaluatedCount:e.evaluatedCount??null,
      searchedNodes:e.searchedNodes??null,completedDepth:e.completedDepth??null,changedFromBaseline:e.changedFromBaseline??null,
      redMaterial:f.red.material,whiteMaterial:f.white.material,redMobility:f.red.mobility,whiteMobility:f.white.mobility});
    snapshot(event.seq);
  }
  return {version:ANALYTICS_VERSION,scope:'all recorded turns in this replay',trust:replay.manifest.trust||'untrusted_client',
    generatedAt:new Date().toISOString(),matchId:replay.manifest.matchId,profile:replay.manifest.profile,
    outcome:replay.outcome||null,turns:moves.length,bySide,byPhase,sourceCounts,
    timing:{opponent:distribution(latencies),humanElapsed:distribution(humanTimes),provider:distribution(providerTimes),search:distribution(searches)},
    search:{nodes:distribution(nodes),depth:distribution(depths),legalCount:distribution(legalCounts),candidateCoverage:distribution(coverage),
      budgetExhausted:exhausted,totalPruned:pruned},
    jev:{decisions:sourceCounts.jev,calls,retries,failedAttempts:failures,serviceFailures,changedFromBaseline:changed,
      changedRate:ratio(changed,sourceCounts.jev),confidence:distribution(confidence),entropyBits:distribution(entropies),
      searchRegret:distribution(regrets),inputTokens,outputTokens,usageKnownCalls:usageKnown,unknownUsageCalls,
      costUSD:null,costNote:'Unknown unless provider pricing is explicitly configured; not an invoice.'},
    heatmaps:{occupancy,landings,captures:capturesAt,snapshots:points.length},points,moves,candidates,
    notes:['Heuristic values and search regret are not solved game values or win probabilities.',
      'Human elapsed time may include network delay, background tabs and time away.',
      'Client telemetry never enters authoritative scores. No IP addresses, keystrokes or chat text are collected.']};
}
/** Excel-compatible escaping prevents formula injection in exports. */
function csvCell(value) {
  let text = value === null || value === undefined ? '' : typeof value==='object' ? JSON.stringify(value) : String(value);
  if(typeof value==='string' && /^[\s]*[=+\-@\t\r]/.test(text)) text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export function toCSV(rows) {
  if(!rows.length)return '';
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return [keys.map(csvCell).join(','),...rows.map(r=>keys.map(k=>csvCell(r[k])).join(','))].join('\r\n')+'\r\n';
}
export function flatEvents(replay) { return replay.events.map(e=>({seq:e.seq,at:e.at,kind:e.kind,actor:e.actor,
  action:e.action?.id||'',preHash:e.preHash,postHash:e.postHash,previousHash:e.previousHash,eventHash:e.eventHash,evidence:e.evidence})); }
