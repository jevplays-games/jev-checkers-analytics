import { prepareSearch, evaluateFast, BUDGET as ENGINE_BUDGET } from './engine.js';
import { getLegalActions, getOutcome, applyGeneratedAction, owner, isKing, coords, squareAt, otherSide } from './rules.js';
export const MODEL_ID = 'jev-1.13.0';
export const STRATEGY_VERSION = 'checkers-strategy-1.0.0';
export const PROFILES = Object.freeze({
  easy: { depth: 1, nodes: 1000, candidates: 8, factors: ['mobility'] },
  normal: { depth: 3, nodes: 10000, candidates: 16, factors: ['promotion','mobility','support'] },
  hard: { depth: 5, nodes: 50000, candidates: 24, factors: ['promotion','mobility','support','trap'] },
  jev: { depth: 7, nodes: 200000, candidates: 32, factors: ['promotion','mobility','support','trap'] }
});
export function profileFor(difficulty = 'normal') {
  if (!Object.hasOwn(PROFILES, difficulty)) throw new Error('Unknown difficulty');
  return { version: STRATEGY_VERSION, model: MODEL_ID, difficulty, ...structuredClone(PROFILES[difficulty]),
    captureExtension: 4, weights: { promotion: 40, mobility: 30, support: 30, trap: -60 },
    evaluation: { man: 100, king: 175, advancement: 4, mobility: 6, center: 8 },
    tieBreak: 'ascii-action-id', quantization: 4, rubricVersion: 'checkers-factors-v1' };
}
export function features(state) {
  const result = {};
  for (const side of ['red','white']) {
    const f = { men: 0, kings: 0, material: 0, advancement: 0, mobility: 0, center: 0,
      support: 0, edge: 0, backRank: 0, nearPromotion: 0, captureActions: 0, maxCapture: 0 };
    state.board.forEach((p, i) => {
      if (owner(p) !== side) return;
      const [r,c] = coords(i+1), a = side === 'red' ? r : 7-r;
      if (isKing(p)) f.kings++; else { f.men++; f.advancement += a; if (a >= 5) f.nearPromotion++; }
      if (r >= 2 && r <= 5 && c >= 2 && c <= 5) f.center++;
      if (c === 0 || c === 7) f.edge++;
      if (a === 0) f.backRank++;
      for (const dr of [-1,1]) for (const dc of [-1,1]) {
        const sq = squareAt(r+dr,c+dc); if (sq && owner(state.board[sq-1]) === side) f.support++;
      }
    });
    const actions = getLegalActions({ ...state, toMove: side });
    f.support /= 2; f.material = f.men*100 + f.kings*175; f.mobility = actions.length;
    f.captureActions = actions.filter(a => a.captured.length).length;
    f.maxCapture = Math.max(0, ...actions.map(a => a.captured.length)); result[side] = f;
  }
  result.pieceCount = result.red.men + result.white.men + result.red.kings + result.white.kings;
  result.phase = result.pieceCount > 18 ? 'opening' : result.pieceCount > 8 ? 'middlegame' : 'endgame';
  return result;
}
/** Original object-based evaluation, kept as the reference the fast evaluate must match exactly. */
export function evaluateReference(state, perspective = state.toMove) {
  const f = features(state), us = f[perspective], them = f[otherSide(perspective)];
  return us.material-them.material + 4*(us.advancement-them.advancement) + 6*(us.mobility-them.mobility) + 8*(us.center-them.center);
}
const compare = (a,b) => b.score-a.score || (a.action.id < b.action.id ? -1 : a.action.id > b.action.id ? 1 : 0);
const BUDGET = Symbol('node budget exhausted');
/** Original clone-per-node search, kept as the reference the fast search must match exactly (except searchMs). */
export function searchCandidatesReference(state, profile = profileFor()) {
  const started = performance.now(), actions = getLegalActions(state), perspective = state.toMove;
  if (!actions.length || getOutcome(state)) throw new Error('Cannot search terminal state');
  let nodes = 0, cutoffs = 0, completedDepth = 0, exhausted = false;
  let roots = actions.map(action => {
    const after = applyGeneratedAction(state, action), outcome = getOutcome(after);
    const immediateWin = outcome?.winner === perspective;
    const immediateLoss = !outcome && getLegalActions(after).some(reply => getOutcome(applyGeneratedAction(after, reply))?.winner === otherSide(perspective));
    return { action, after, immediateWin, immediateLoss, score: outcome ? outcome.winner === null ? 0 : immediateWin ? 1000000 : -1000000 : evaluateReference(after,perspective), pv: [action.id], frontierBoard: after.board };
  });
  const terminalValue = (outcome, side, distance) => !outcome.winner ? 0 : outcome.winner === side ? 1000000-distance : -1000000+distance;
  function negamax(s, depth, alpha, beta, extension, distance) {
    if (++nodes > profile.nodes) throw BUDGET;
    const outcome = getOutcome(s);
    if (outcome) return { score: terminalValue(outcome,s.toMove,distance), pv: [], board: s.board };
    const legal = getLegalActions(s);
    const extend = depth <= 0 && extension > 0 && legal[0]?.captured.length;
    if (depth <= 0 && !extend) return { score: evaluateReference(s), pv: [], board: s.board };
    let best = { score: -Infinity, pv: [], board: s.board };
    for (const action of legal) {
      const child = negamax(applyGeneratedAction(s,action),depth-1,-beta,-alpha,extend ? extension-1 : extension,distance+1);
      const score = -child.score;
      if (score > best.score) best = { score, pv: [action.id,...child.pv], board: child.board };
      alpha = Math.max(alpha, score);
      if (alpha >= beta) { cutoffs++; break; }
    }
    return best;
  }
  for (let depth=1; depth<=profile.depth; depth++) {
    const iteration = [];
    try {
      for (const root of roots) {
        const child = negamax(root.after,depth-1,-Infinity,Infinity,profile.captureExtension,1);
        iteration.push({ ...root, score: -child.score, pv: [root.action.id,...child.pv], frontierBoard: child.board });
      }
      roots = iteration; completedDepth = depth;
    } catch(error) { if (error !== BUDGET) throw error; exhausted = true; break; }
  }
  const wins = roots.filter(r => r.immediateWin), safe = roots.filter(r => !r.immediateLoss);
  const pool = wins.length ? wins : safe.length ? safe : roots;
  const candidates = [...pool].sort(compare).slice(0,profile.candidates);
  return { candidates, allCandidates: [...roots].sort(compare), legalCount: actions.length,
    excludedImmediateLosses: wins.length ? 0 : safe.length ? roots.length-safe.length : 0,
    prunedCount: actions.length-candidates.length, completedDepth, searchedNodes: Math.min(nodes,profile.nodes),
    cutoffs, exhausted, searchMs: performance.now()-started, forced: actions.length === 1,
    tacticalWin: wins.length > 0, budget: profile.nodes };
}
export function evaluate(state, perspective = state.toMove) {
  const fast = evaluateFast(state, perspective);
  return fast === undefined ? evaluateReference(state, perspective) : fast;
}
/** Complete root iterations only. No transposition reuse across different draw histories. */
export function searchCandidates(state, profile = profileFor()) {
  const started = performance.now(), actions = getLegalActions(state), perspective = state.toMove;
  if (!actions.length || getOutcome(state)) throw new Error('Cannot search terminal state');
  const engine = prepareSearch(state, actions, profile);
  if (!engine) return searchCandidatesReference(state, profile);
  let completedDepth = 0, exhausted = false;
  let roots = actions.map((action, i) => {
    const after = applyGeneratedAction(state, action), info = engine.rootOutcome(i);
    const immediateWin = info.outcome === 'win';
    return { action, after, immediateWin, immediateLoss: info.immediateLoss,
      score: info.outcome ? info.outcome === 'draw' ? 0 : immediateWin ? 1000000 : -1000000 : info.score,
      pv: [action.id], frontierBoard: after.board };
  });
  engine.setBudget(profile.nodes);
  for (let depth = 1; depth <= profile.depth; depth++) {
    const iteration = [];
    try {
      for (let i = 0; i < roots.length; i++) {
        const child = engine.searchRoot(i, depth, profile.captureExtension);
        iteration.push({ ...roots[i], score: child.score, pv: [roots[i].action.id, ...child.pv], frontierBoard: child.board });
      }
      roots = iteration; completedDepth = depth;
    } catch (error) { if (error !== ENGINE_BUDGET) throw error; exhausted = true; break; }
  }
  const wins = roots.filter(r => r.immediateWin), safe = roots.filter(r => !r.immediateLoss);
  const pool = wins.length ? wins : safe.length ? safe : roots;
  const candidates = [...pool].sort(compare).slice(0, profile.candidates);
  return { candidates, allCandidates: [...roots].sort(compare), legalCount: actions.length,
    excludedImmediateLosses: wins.length ? 0 : safe.length ? roots.length - safe.length : 0,
    prunedCount: actions.length - candidates.length, completedDepth, searchedNodes: Math.min(engine.nodes, profile.nodes),
    cutoffs: engine.cutoffs, exhausted, searchMs: performance.now() - started, forced: actions.length === 1,
    tacticalWin: wins.length > 0, budget: profile.nodes };
}
export function rankCandidates(search, factorsByAction, profile) {
  return search.candidates.map(c => {
    const factors = factorsByAction[c.action.id] || {};
    let adjustment = 0;
    for (const factor of profile.factors) {
      const value = Number((factors[factor] ?? (factor === 'trap' ? 0 : 2)).toFixed(4));
      adjustment += profile.weights[factor] * (factor === 'trap' ? value : (value-2)/2);
    }
    return { ...c, tacticalScore: c.score, adjustment, score: Number((c.score+adjustment).toFixed(4)), factors };
  }).sort(compare);
}
export function searchEvidence(search, ranked = search.candidates) {
  return { legalCount: search.legalCount, evaluatedCount: ranked.length, prunedCount: search.prunedCount,
    excludedImmediateLosses: search.excludedImmediateLosses, completedDepth: search.completedDepth,
    searchedNodes: search.searchedNodes, cutoffs: search.cutoffs, budgetExhausted: search.exhausted,
    searchMs: search.searchMs, forced: search.forced, tacticalWin: search.tacticalWin,
    baselineActionId: search.candidates[0].action.id,
    candidates: ranked.map(c => ({ actionId: c.action.id, path: c.action.path, captured: c.action.captured,
      promotes: c.action.promotes, tacticalScore: c.tacticalScore ?? c.score, adjustment: c.adjustment ?? 0,
      utility: c.score, factors: c.factors || {}, principalVariation: c.pv,
      afterBoard: c.after.board, frontierBoard: c.frontierBoard, features: features(c.after) })) };
}
export function chooseLocalAction(state, difficulty = 'normal') {
  const started = performance.now(), profile = profileFor(difficulty), search = searchCandidates(state,profile);
  return { actionId: search.candidates[0].action.id, source: 'local', model: null,
    evidence: { ...searchEvidence(search), totalMs: performance.now()-started, providerMs: 0,
      questionCount: 0, attempts: [], usage: null, changedFromBaseline: false } };
}
