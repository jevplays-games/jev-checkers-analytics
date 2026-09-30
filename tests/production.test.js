import test from 'node:test';
import assert from 'node:assert/strict';
import { isProduction } from '../scripts/production.mjs';
test('production detection',()=>{
  assert.equal(isProduction({NODE_ENV:'production'}),true);
  assert.equal(isProduction({NODE_ENV:'development',APP_ORIGIN:'https://checkers.jevplay.games'}),true);
  assert.equal(isProduction({APP_ORIGIN:'https://localhost:8787'}),false);
  assert.equal(isProduction({APP_ORIGIN:'http://checkers.jevplay.games'}),false);
  assert.equal(isProduction({APP_ORIGIN:'http://127.0.0.1:8787'}),false);
  assert.equal(isProduction({}),false);
});
