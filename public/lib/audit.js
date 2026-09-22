import { createInitialState, getLegalActions, applyAction, getOutcome, serialize, deserialize } from '../games/checkers/rules.js';
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
}
export const hashState = state => sha256(serialize(state));
export async function sealEvent(fields, previousHash) {
  const event = { schemaVersion: 1, ...fields, previousHash };
  return { ...event, eventHash: await sha256(event) };
}
export async function verifyReplay(replay) {
  if (!replay || replay.format !== 'jev-checkers-audit' || replay.version !== 1 || !Array.isArray(replay.events) || replay.events.length > 20000) throw new Error('Unsupported replay');
  if (!replay.manifest || typeof replay.manifest.matchId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(replay.manifest.matchId) || !replay.manifest.profile) throw new Error('Invalid manifest');
  let state = deserialize(replay.manifest.initialState || createInitialState());
  if (!['red','white'].includes(replay.manifest.humanSide)) throw new Error('Invalid human side');
  if (replay.manifest.officialStart && serialize(state) !== serialize(createInitialState())) throw new Error('Nonstandard official start');
  let hash = await sha256(replay.manifest), administrative = null;
  for (let index=0; index<replay.events.length; index++) {
    const event = replay.events[index], { eventHash, ...body } = event;
    if (event.schemaVersion !== 1 || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid event envelope');
    if (event.seq !== index+1 || event.matchId !== replay.manifest.matchId || event.previousHash !== hash) throw new Error(`Broken event sequence at ${index+1}`);
    if (await sha256(body) !== eventHash) throw new Error(`Event hash mismatch at ${event.seq}`);
    if (event.preHash !== await hashState(state)) throw new Error(`Pre-state mismatch at ${event.seq}`);
    if (administrative) throw new Error('Event after administrative termination');
    if (event.kind === 'move') {
      const expected = state.toMove === replay.manifest.humanSide ? 'human' : 'opponent';
      if (event.actor !== expected) throw new Error(`Wrong actor at ${event.seq}`);
      if (expected === 'opponent' && !['jev','forced','local'].includes(event.evidence?.source)) throw new Error('Missing opponent provenance');
      if (replay.manifest.opponent === 'jev' && expected === 'opponent' && event.evidence?.source === 'local') throw new Error('Substituted local opponent');
      if (event.evidence?.source === 'jev' && event.evidence.model !== replay.manifest.profile.model) throw new Error('Model mismatch');
      const legal = getLegalActions(state).find(a => a.id === event.action?.id);
      if (!legal || canonical(legal) !== canonical(event.action)) throw new Error(`Move metadata mismatch at ${event.seq}`);
      state = applyAction(state,event.action.id);
    } else if (['resign','abandoned','service_failure'].includes(event.kind)) {
      if (getOutcome(state)) throw new Error('Administrative result after board termination');
      if (event.kind === 'resign' && (event.actor !== 'human' || state.toMove !== replay.manifest.humanSide)) throw new Error('Invalid resignation');
      if (event.kind !== 'resign' && event.actor !== 'system') throw new Error('Invalid administrative actor');
      if (event.kind === 'abandoned' && state.toMove !== replay.manifest.humanSide) throw new Error('Invalid abandonment');
      if (event.kind === 'service_failure' && state.toMove === replay.manifest.humanSide) throw new Error('Invalid service failure');
      administrative = { winner: event.kind === 'service_failure' ? null : replay.manifest.humanSide === 'red' ? 'white' : 'red', reason: event.kind };
    } else throw new Error('Unknown event kind');
    if (event.postHash !== await hashState(state)) throw new Error(`Post-state mismatch at ${event.seq}`);
    hash = eventHash;
  }
  const outcome = administrative || getOutcome(state);
  if (replay.finalState && serialize(state) !== serialize(deserialize(replay.finalState))) throw new Error('Final state mismatch');
  if (replay.finalHash && replay.finalHash !== hash) throw new Error('Final chain head mismatch');
  if (replay.outcome && canonical(replay.outcome) !== canonical(outcome)) throw new Error('Outcome mismatch');
  return { valid: true, eventCount: replay.events.length, finalHash: hash, state, outcome,
    trust: 'Structural integrity only. Official provenance requires the originating server database.' };
}
