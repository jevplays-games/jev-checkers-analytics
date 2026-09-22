/** American checkers / English draughts. Pure, deterministic and DOM independent. */
export const RULES_VERSION = 'american-8x8-web-v1';
export const ENGINE_VERSION = '1.0.0';
export const otherSide = side => side === 'red' ? 'white' : 'red';
export const owner = piece => piece === 1 || piece === 2 ? 'red' : piece === 3 || piece === 4 ? 'white' : null;
export const isKing = piece => piece === 2 || piece === 4;
export function coords(square) {
  const s = square - 1, row = Math.floor(s / 4);
  return [row, 2 * (s % 4) + ((row + 1) % 2)];
}
export function squareAt(row, col) {
  return row < 0 || row > 7 || col < 0 || col > 7 || (row + col) % 2 !== 1
    ? null : row * 4 + Math.floor(col / 2) + 1;
}
const directions = piece => isKing(piece) ? [-1, 1] : piece === 1 ? [1] : [-1];
const crowns = (piece, square) => !isKing(piece) && coords(square)[0] === (piece === 1 ? 7 : 0);
const pad = n => String(n).padStart(2, '0');
function move(path, captured, promotes) {
  return { id: `${captured.length ? 'j:' : 'm:'}${path.map(pad).join(captured.length ? 'x' : '-')}`, path, captured, promotes };
}
export function positionKey(state) {
  return `${RULES_VERSION}|${state.toMove}|${state.board.join('')}`;
}
export function createInitialState() {
  const state = { rulesVersion: RULES_VERSION, engineVersion: ENGINE_VERSION,
    board: [...Array(12).fill(1), ...Array(8).fill(0), ...Array(12).fill(3)],
    toMove: 'red', ply: 0, noProgressPly: 0, repetitions: {} };
  state.repetitions[positionKey(state)] = 1;
  return state;
}
/** All actions are complete turns, including complete mandatory jump chains. */
export function getLegalActions(state) {
  const captures = [], quiet = [], side = state.toMove;
  function extend(board, square, piece, path, taken) {
    let extended = false;
    const [r, c] = coords(square);
    for (const dr of directions(piece)) for (const dc of [-1, 1]) {
      const middle = squareAt(r + dr, c + dc), to = squareAt(r + dr * 2, c + dc * 2);
      if (!to || !middle || board[to - 1] || !board[middle - 1] || owner(board[middle - 1]) === side) continue;
      extended = true;
      const b = board.slice(); b[square - 1] = 0; b[middle - 1] = 0; b[to - 1] = piece;
      const p = [...path, to], t = [...taken, middle];
      // In English draughts crowning ends the turn, even if a new king could jump.
      if (crowns(piece, to)) captures.push(move(p, t, true));
      else extend(b, to, piece, p, t);
    }
    if (!extended && taken.length) captures.push(move(path, taken, false));
  }
  state.board.forEach((piece, i) => { if (owner(piece) === side) extend(state.board, i + 1, piece, [i + 1], []); });
  if (captures.length) return captures.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  state.board.forEach((piece, i) => {
    if (owner(piece) !== side) return;
    const [r, c] = coords(i + 1);
    for (const dr of directions(piece)) for (const dc of [-1, 1]) {
      const to = squareAt(r + dr, c + dc);
      if (to && !state.board[to - 1]) quiet.push(move([i + 1, to], [], crowns(piece, to)));
    }
  });
  return quiet.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function getOutcome(state) {
  const red = state.board.some(p => owner(p) === 'red'), white = state.board.some(p => owner(p) === 'white');
  if (!red || !white) return { winner: red ? 'red' : white ? 'white' : otherSide(state.toMove), reason: 'no-pieces' };
  if (!getLegalActions(state).length) return { winner: otherSide(state.toMove), reason: 'blocked' };
  if ((state.repetitions[positionKey(state)] || 0) >= 3) return { winner: null, reason: 'repetition' };
  if (state.noProgressPly >= 80) return { winner: null, reason: 'no-progress' };
  return null;
}
/** Internal transition: only pass an action from getLegalActions for this state. */
export function applyGeneratedAction(state, action) {
  const board = state.board.slice(), from = action.path[0], to = action.path.at(-1), piece = board[from - 1];
  board[from - 1] = 0;
  for (const sq of action.captured) board[sq - 1] = 0;
  board[to - 1] = action.promotes ? (owner(piece) === 'red' ? 2 : 4) : piece;
  const irreversible = action.captured.length > 0 || !isKing(piece);
  const next = { ...state, board, toMove: otherSide(state.toMove), ply: state.ply + 1,
    noProgressPly: irreversible ? 0 : state.noProgressPly + 1,
    repetitions: irreversible ? {} : { ...state.repetitions } };
  const key = positionKey(next); next.repetitions[key] = (next.repetitions[key] || 0) + 1;
  return next;
}
export function applyAction(state, actionId) {
  if (getOutcome(state)) throw new Error('Game is already terminal');
  const action = getLegalActions(state).find(a => a.id === actionId);
  if (!action) throw new Error('Illegal action');
  return applyGeneratedAction(state, action);
}
export function validateState(state) {
  if (!state || state.rulesVersion !== RULES_VERSION || state.engineVersion !== ENGINE_VERSION) throw new Error('Unsupported rules or engine version');
  if (!Array.isArray(state.board) || state.board.length !== 32 || state.board.some(p => !Number.isInteger(p) || p < 0 || p > 4)) throw new Error('Invalid board');
  if (!['red','white'].includes(state.toMove)) throw new Error('Invalid active side');
  if (!Number.isSafeInteger(state.ply) || state.ply < 0 || !Number.isSafeInteger(state.noProgressPly) || state.noProgressPly < 0 || state.noProgressPly > 80 || state.noProgressPly > state.ply) throw new Error('Invalid counters');
  for (const side of ['red','white']) if (state.board.filter(p => owner(p) === side).length > 12) throw new Error('Too many pieces');
  if (state.board.slice(0,4).includes(3) || state.board.slice(28).includes(1)) throw new Error('Uncrowned piece on king row');
  if (!state.repetitions || Array.isArray(state.repetitions) || typeof state.repetitions !== 'object' || Object.keys(state.repetitions).length > 81) throw new Error('Invalid repetition table');
  for (const [key, value] of Object.entries(state.repetitions)) {
    if (!new RegExp(`^${RULES_VERSION}\\|(red|white)\\|[0-4]{32}$`).test(key) || !Number.isInteger(value) || value < 1 || value > 3) throw new Error('Invalid repetition entry');
  }
  if (!state.repetitions[positionKey(state)]) throw new Error('Current position is missing from repetition table');
  return state;
}
export function serialize(state) {
  return JSON.stringify({ rulesVersion: state.rulesVersion, engineVersion: state.engineVersion,
    board: state.board, toMove: state.toMove, ply: state.ply, noProgressPly: state.noProgressPly,
    repetitions: Object.fromEntries(Object.entries(state.repetitions).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) });
}
export function deserialize(data) { return validateState(typeof data === 'string' ? JSON.parse(data) : structuredClone(data)); }
export const checkers = { id: 'checkers', rulesVersion: RULES_VERSION, engineVersion: ENGINE_VERSION,
  createInitialState, getLegalActions, applyAction, getOutcome, serialize, deserialize };
