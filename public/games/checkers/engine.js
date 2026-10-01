/**
 * Allocation-free mutable checkers engine used by the bounded search.
 *
 * It reproduces rules.js (getLegalActions, getOutcome, applyGeneratedAction) and strategy.js (evaluate)
 * exactly, but works on one mutable board with do/undo, precomputed move tables and numeric repetition
 * tracking. rules.js and strategy.js keep the original implementations as the exported references
 * (getLegalActions, searchCandidatesReference, evaluateReference); tests assert equivalence.
 * Single threaded and synchronous: module level buffers are safe because nothing here awaits.
 */
import { RULES_VERSION } from './rules.js';

const RED = 1, WHITE = 2;
const OWN = Uint8Array.from([0, 1, 1, 2, 2]);
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const DLO = Uint8Array.from([0, 2, 0, 0, 0]); // first direction per piece (men move forward only)
const DHI = Uint8Array.from([0, 4, 4, 2, 4]);
const ROW = new Uint8Array(32), COL = new Uint8Array(32);
const SQ_AT = new Int8Array(64).fill(-1);
for (let s = 0; s < 32; s++) {
  const r = Math.floor(s / 4), c = 2 * (s % 4) + ((r + 1) % 2);
  ROW[s] = r; COL[s] = c; SQ_AT[r * 8 + c] = s;
}
const at = (r, c) => r < 0 || r > 7 || c < 0 || c > 7 ? -1 : SQ_AT[r * 8 + c];
const STEP = new Int8Array(4 * 32).fill(-1), JUMP = new Int8Array(4 * 32).fill(-1), MID = new Int8Array(32 * 32).fill(-1);
for (let d = 0; d < 4; d++) for (let s = 0; s < 32; s++) {
  const [dr, dc] = DIRS[d];
  STEP[d * 32 + s] = at(ROW[s] + dr, COL[s] + dc);
  const to = at(ROW[s] + 2 * dr, COL[s] + 2 * dc);
  JUMP[d * 32 + s] = to;
  if (to >= 0) MID[s * 32 + to] = STEP[d * 32 + s];
}
const CROWN = new Uint8Array(5 * 32);
for (let s = 0; s < 32; s++) { CROWN[1 * 32 + s] = ROW[s] === 7 ? 1 : 0; CROWN[3 * 32 + s] = ROW[s] === 0 ? 1 : 0; }
/** Signed piece-square value: material + 4 * advancement (men) + 8 * centre, positive for red, negative for white. */
const PV = new Int32Array(5 * 32);
for (let s = 0; s < 32; s++) {
  const r = ROW[s], c = COL[s], centre = r >= 2 && r <= 5 && c >= 2 && c <= 5 ? 8 : 0;
  PV[1 * 32 + s] = 100 + 4 * r + centre; PV[2 * 32 + s] = 175 + centre;
  PV[3 * 32 + s] = -(100 + 4 * (7 - r) + centre); PV[4 * 32 + s] = -(175 + centre);
}
// Deterministic Zobrist keys (only a prefilter: equal hashes are always confirmed by an exact board compare).
const ZB = new Int32Array(5 * 32);
{ let x = 0x9e3779b9; const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x | 0; };
  for (let p = 1; p < 5; p++) for (let s = 0; s < 32; s++) ZB[p * 32 + s] = next(); }
const ZSIDE = 0x5bd1e995 | 0;
const pad = n => String(n).padStart(2, '0');
const QID = new Array(32 * 32), JID = new Array(32 * 32);
for (let a = 0; a < 32; a++) for (let b = 0; b < 32; b++) {
  QID[a * 32 + b] = `m:${pad(a + 1)}-${pad(b + 1)}`; JID[a * 32 + b] = `j:${pad(a + 1)}x${pad(b + 1)}`;
}

/** Move record layout in an Int32Array: [ncap, promotes, path0 .. pathN] (0-based squares). */
export const STRIDE = 36;
const B = new Uint8Array(32);
let RED_N = 0, WHITE_N = 0, PSUM = 0, H = 0, LEAF = 0;
let CAP_FLAG = 0, GEN_N = 0, GEN_BUF = null, GEN_PLY = 0;
const PATH = new Int32Array(40);
let CAP = 8;
let BUFS = [], TM = new Uint8Array(0), NP = new Int32Array(0), RS = new Int32Array(0), BV = new Uint8Array(0), HS = new Int32Array(0);
let SB = new Uint8Array(0), UPS = new Int32Array(0), UH = new Int32Array(0), URED = new Uint8Array(0), UWHITE = new Uint8Array(0), UPIECE = new Uint8Array(0), CAPS = new Uint8Array(0);
let FB = [], PVIDS = [], PVLEN = new Int32Array(0);
let baseN = 0, baseH = new Int32Array(0), baseTM = new Uint8Array(0), baseB = new Uint8Array(0), baseCount = new Int32Array(0);

function ensure(maxP) {
  if (maxP < CAP && BUFS.length) return;
  CAP = Math.max(maxP + 2, CAP * 2);
  const n = CAP + 1;
  const grow = (A, size) => { const o = new A.constructor(n * size); o.set(A); return o; };
  TM = grow(TM, 1); NP = grow(NP, 1); RS = grow(RS, 1); BV = grow(BV, 1); HS = grow(HS, 1);
  SB = grow(SB, 32); UPS = grow(UPS, 1); UH = grow(UH, 1); URED = grow(URED, 1); UWHITE = grow(UWHITE, 1);
  UPIECE = grow(UPIECE, 1); CAPS = grow(CAPS, 34); PVLEN = grow(PVLEN, 1);
  while (BUFS.length < n) { BUFS.push(new Int32Array(48 * STRIDE)); FB.push(new Uint8Array(32)); PVIDS.push(new Array(n + 4)); }
  for (const a of PVIDS) while (a.length < n + 4) a.push('');
}

function emit(k, promotes) {
  let buf = GEN_BUF;
  const off = GEN_N * STRIDE;
  if (off + STRIDE > buf.length) { const o = new Int32Array(buf.length * 2); o.set(buf); BUFS[GEN_PLY] = GEN_BUF = buf = o; }
  buf[off] = k; buf[off + 1] = promotes;
  for (let i = 0; i <= k; i++) buf[off + 2 + i] = PATH[i];
  GEN_N++;
}
function chainGen(sq, piece, k, side) {
  let extended = false;
  for (let d = DLO[piece], hi = DHI[piece]; d < hi; d++) {
    const to = JUMP[d * 32 + sq];
    if (to < 0) continue;
    const mid = STEP[d * 32 + sq], mp = B[mid];
    if (B[to] !== 0 || mp === 0 || OWN[mp] === side) continue;
    extended = true;
    B[sq] = 0; B[mid] = 0; B[to] = piece; PATH[k + 1] = to;
    // In English draughts crowning ends the turn, even if a new king could jump.
    if (CROWN[piece * 32 + to]) emit(k + 1, 1); else chainGen(to, piece, k + 1, side);
    B[to] = 0; B[mid] = mp; B[sq] = piece;
  }
  if (!extended && k > 0) emit(k, 0);
}
function chainCount(sq, piece, k, side) {
  let extended = false, c = 0;
  for (let d = DLO[piece], hi = DHI[piece]; d < hi; d++) {
    const to = JUMP[d * 32 + sq];
    if (to < 0) continue;
    const mid = STEP[d * 32 + sq], mp = B[mid];
    if (B[to] !== 0 || mp === 0 || OWN[mp] === side) continue;
    extended = true;
    B[sq] = 0; B[mid] = 0; B[to] = piece;
    c += CROWN[piece * 32 + to] ? 1 : chainCount(to, piece, k + 1, side);
    B[to] = 0; B[mid] = mp; B[sq] = piece;
  }
  return !extended && k > 0 ? c + 1 : c;
}
/** Writes the legal moves for `side` to BUFS[ply] in getLegalActions order; returns the count. */
function gen(ply, side) {
  GEN_BUF = BUFS[ply]; GEN_PLY = ply; GEN_N = 0;
  for (let sq = 0; sq < 32; sq++) {
    const piece = B[sq];
    if (OWN[piece] !== side) continue;
    PATH[0] = sq; chainGen(sq, piece, 0, side);
  }
  CAP_FLAG = GEN_N > 0 ? 1 : 0;
  if (GEN_N) return GEN_N;
  for (let sq = 0; sq < 32; sq++) {
    const piece = B[sq];
    if (OWN[piece] !== side) continue;
    for (let d = DLO[piece], hi = DHI[piece]; d < hi; d++) {
      const to = STEP[d * 32 + sq];
      if (to < 0 || B[to] !== 0) continue;
      let buf = GEN_BUF;
      const off = GEN_N * STRIDE;
      if (off + STRIDE > buf.length) { const o = new Int32Array(buf.length * 2); o.set(buf); BUFS[ply] = GEN_BUF = buf = o; }
      buf[off] = 0; buf[off + 1] = CROWN[piece * 32 + to]; buf[off + 2] = sq; buf[off + 3] = to;
      GEN_N++;
    }
  }
  return GEN_N;
}
/** Same count as gen() without recording moves. */
function count(side) {
  let c = 0;
  for (let sq = 0; sq < 32; sq++) {
    const piece = B[sq];
    if (OWN[piece] === side) c += chainCount(sq, piece, 0, side);
  }
  CAP_FLAG = c > 0 ? 1 : 0;
  if (c) return c;
  for (let sq = 0; sq < 32; sq++) {
    const piece = B[sq];
    if (OWN[piece] !== side) continue;
    for (let d = DLO[piece], hi = DHI[piece]; d < hi; d++) { const to = STEP[d * 32 + sq]; if (to >= 0 && B[to] === 0) c++; }
  }
  return c;
}
function moveId(buf, off) {
  const k = buf[off];
  if (k === 0) return QID[buf[off + 2] * 32 + buf[off + 3]];
  if (k === 1) return JID[buf[off + 2] * 32 + buf[off + 3]];
  let id = 'j:' + pad(buf[off + 2] + 1);
  for (let i = 1; i <= k; i++) id += 'x' + pad(buf[off + 2 + i] + 1);
  return id;
}
function doMove(p, buf, off) {
  const q = p + 1, k = buf[off], from = buf[off + 2], to = buf[off + 2 + (k > 0 ? k : 1)], piece = B[from];
  UPS[q] = PSUM; UH[q] = H; URED[q] = RED_N; UWHITE[q] = WHITE_N; UPIECE[q] = piece;
  B[from] = 0; PSUM -= PV[piece * 32 + from]; H ^= ZB[piece * 32 + from];
  for (let j = 0; j < k; j++) {
    const mid = MID[buf[off + 2 + j] * 32 + buf[off + 3 + j]], mp = B[mid];
    CAPS[q * 34 + j] = mp; B[mid] = 0; PSUM -= PV[mp * 32 + mid]; H ^= ZB[mp * 32 + mid];
    if (OWN[mp] === RED) RED_N--; else WHITE_N--;
  }
  const placed = buf[off + 1] ? (piece === 1 ? 2 : 4) : piece;
  B[to] = placed; PSUM += PV[placed * 32 + to]; H ^= ZB[placed * 32 + to] ^ ZSIDE;
  TM[q] = 3 - TM[p];
  if (k > 0 || piece === 1 || piece === 3) { NP[q] = 0; RS[q] = q; BV[q] = 0; }
  else { NP[q] = NP[p] + 1; RS[q] = RS[p]; BV[q] = BV[p]; }
  HS[q] = H; SB.set(B, q * 32);
}
function undoMove(p, buf, off) {
  const q = p + 1, k = buf[off], from = buf[off + 2], to = buf[off + 2 + (k > 0 ? k : 1)];
  B[to] = 0; B[from] = UPIECE[q];
  for (let j = 0; j < k; j++) B[MID[buf[off + 2 + j] * 32 + buf[off + 3 + j]]] = CAPS[q * 34 + j];
  PSUM = UPS[q]; H = UH[q]; RED_N = URED[q]; WHITE_N = UWHITE[q];
}
function sameAsCurrent(arr, base) {
  for (let i = 0; i < 32; i++) if (arr[base + i] !== B[i]) return false;
  return true;
}
/** Occurrences of the position at index p, with the same reset-on-irreversible semantics as state.repetitions. */
function repCount(p) {
  const h = HS[p], tm = TM[p];
  let c = 0;
  if (BV[p]) for (let i = 0; i < baseN; i++) if (baseH[i] === h && baseTM[i] === tm && sameAsCurrent(baseB, i * 32)) { c += baseCount[i]; break; }
  for (let j = RS[p] > 1 ? RS[p] : 1; j <= p; j++) if (HS[j] === h && TM[j] === tm && sameAsCurrent(SB, j * 32)) c++;
  return c;
}
/** 0 = not terminal, 1/2 = that side won, 3 = draw. Leaves the mover's legal moves in BUFS[p]. */
function outcomeAt(p) {
  if (RED_N === 0 || WHITE_N === 0) return RED_N ? RED : WHITE;
  const tm = TM[p];
  if (gen(p, tm) === 0) return 3 - tm;
  if (repCount(p) >= 3 || NP[p] >= 80) return 3;
  return 0;
}
function evalPosition(perspective) {
  const other = 3 - perspective;
  return (perspective === RED ? PSUM : -PSUM) + 6 * (count(perspective) - count(other));
}

/** Loads a state; returns false when the state is outside what the engine models (callers fall back). */
function load(state, maxP) {
  const board = state.board;
  if (!Array.isArray(board) || board.length !== 32 || (state.toMove !== 'red' && state.toMove !== 'white')) return false;
  ensure(maxP);
  RED_N = 0; WHITE_N = 0; PSUM = 0; H = 0;
  for (let s = 0; s < 32; s++) {
    const p = board[s];
    if (p !== 0 && p !== 1 && p !== 2 && p !== 3 && p !== 4) return false;
    B[s] = p; PSUM += PV[p * 32 + s]; H ^= ZB[p * 32 + s];
    if (p === 1 || p === 2) RED_N++; else if (p) WHITE_N++;
  }
  const tm = state.toMove === 'red' ? RED : WHITE;
  if (tm === WHITE) H ^= ZSIDE;
  TM[0] = tm; NP[0] = state.noProgressPly; RS[0] = 0; BV[0] = 1; HS[0] = H; SB.set(B, 0);
  const reps = state.repetitions && typeof state.repetitions === 'object' ? Object.entries(state.repetitions) : [];
  baseN = 0;
  if (baseH.length < reps.length) { baseH = new Int32Array(reps.length); baseTM = new Uint8Array(reps.length); baseB = new Uint8Array(reps.length * 32); baseCount = new Int32Array(reps.length); }
  const prefix = RULES_VERSION + '|';
  for (const [key, value] of reps) {
    if (!key.startsWith(prefix) || !Number.isFinite(value)) continue;
    const rest = key.slice(prefix.length), bar = rest.indexOf('|');
    if (bar < 0 || rest.length - bar - 1 !== 32) continue;
    const side = rest.slice(0, bar) === 'red' ? RED : rest.slice(0, bar) === 'white' ? WHITE : 0;
    if (!side) continue;
    let h = side === WHITE ? ZSIDE : 0, ok = true;
    for (let s = 0; s < 32; s++) {
      const d = rest.charCodeAt(bar + 1 + s) - 48;
      if (d < 0 || d > 4) { ok = false; break; }
      baseB[baseN * 32 + s] = d; h ^= ZB[d * 32 + s];
    }
    if (!ok) continue;
    baseH[baseN] = h; baseTM[baseN] = side; baseCount[baseN] = value; baseN++;
  }
  return true;
}

const BUDGET = Symbol('node budget exhausted');
export { BUDGET };
/** Mutable search context; fields are set by runSearch. */
let nodes = 0, limit = 0, cutoffs = 0;
function negamax(depth, alpha, beta, extension, p) {
  if (++nodes > limit) throw BUDGET;
  const tm = TM[p];
  LEAF = 1;
  if (RED_N === 0 || WHITE_N === 0) return (RED_N ? RED : WHITE) === tm ? 1000000 - p : -1000000 + p;
  let n;
  if (depth > 0) n = gen(p, tm); else n = count(tm);
  if (n === 0) return -1000000 + p;
  if (repCount(p) >= 3 || NP[p] >= 80) return 0;
  let extend = 0;
  if (depth <= 0) {
    extend = extension > 0 && CAP_FLAG;
    if (!extend) return (tm === RED ? PSUM : -PSUM) + 6 * (n - count(3 - tm));
    gen(p, tm);
  }
  const buf = BUFS[p], childExt = extend ? extension - 1 : extension, pv = PVIDS[p];
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const off = i * STRIDE;
    doMove(p, buf, off);
    const score = -negamax(depth - 1, -beta, -alpha, childExt, p + 1);
    if (score > best) {
      best = score;
      pv[0] = moveId(buf, off);
      if (LEAF) { PVLEN[p] = 1; FB[p].set(B); }
      else {
        const child = PVIDS[p + 1], len = PVLEN[p + 1];
        for (let j = 0; j < len; j++) pv[j + 1] = child[j];
        PVLEN[p] = len + 1; FB[p].set(FB[p + 1]);
      }
    }
    undoMove(p, buf, off);
    if (score > alpha) alpha = score;
    if (alpha >= beta) { cutoffs++; break; }
  }
  LEAF = 0;
  return best;
}

/**
 * Prepares the root for searchCandidates: returns null when the engine cannot model the state.
 * Otherwise returns { roots: per-action {outcome, immediateWin, immediateLoss, score} , run(depth) }.
 */
export function prepareSearch(state, actions, profile) {
  if (!load(state, (profile.depth | 0) + (profile.captureExtension | 0) + 4)) return null;
  const perspective = TM[0], other = 3 - perspective;
  if (gen(0, perspective) !== actions.length) return null;
  const rootBuf = BUFS[0];
  for (let i = 0; i < actions.length; i++) if (moveId(rootBuf, i * STRIDE) !== actions[i].id) return null;
  return {
    rootOutcome(i) {
      doMove(0, BUFS[0], i * STRIDE);
      const out = outcomeAt(1);
      let immediateLoss = false, score = 0;
      if (!out) {
        const replies = GEN_N, rbuf = BUFS[1];
        for (let r = 0; r < replies && !immediateLoss; r++) {
          doMove(1, rbuf, r * STRIDE);
          if (outcomeAt(2) === other) immediateLoss = true;
          undoMove(1, rbuf, r * STRIDE);
        }
        score = evalPosition(perspective);
      }
      undoMove(0, BUFS[0], i * STRIDE);
      return { outcome: out === 0 ? null : out === 3 ? 'draw' : out === perspective ? 'win' : 'loss', immediateLoss, score };
    },
    /** One whole-root iteration step: search the child after action i. Throws BUDGET when exhausted. */
    searchRoot(i, depth, extension) {
      doMove(0, BUFS[0], i * STRIDE);
      const score = negamax(depth - 1, -Infinity, Infinity, extension, 1);
      let pv, board;
      if (LEAF) { pv = []; board = Array.from(B); }
      else { pv = PVIDS[1].slice(0, PVLEN[1]); board = Array.from(FB[1]); }
      undoMove(0, BUFS[0], i * STRIDE);
      return { score: -score, pv, board };
    },
    setBudget(max) { nodes = 0; limit = max; cutoffs = 0; },
    get nodes() { return nodes; },
    get cutoffs() { return cutoffs; }
  };
}

/** Fast evaluate(state, perspective); returns undefined if the state is outside the engine's model. */
export function evaluateFast(state, perspective) {
  if (!load(state, 2)) return undefined;
  return evalPosition(perspective === 'red' ? RED : WHITE);
}
/** Fast legal-move generation for tests: returns action ids in getLegalActions order, or null. */
export function legalIds(state) {
  if (!load(state, 2)) return null;
  const n = gen(0, TM[0]), ids = [];
  for (let i = 0; i < n; i++) ids.push(moveId(BUFS[0], i * STRIDE));
  return ids;
}
