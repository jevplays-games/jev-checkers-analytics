import { chooseLocalAction } from './strategy.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, decision: chooseLocalAction(data.state,data.difficulty) }); }
  catch(error) { self.postMessage({ id: data.id, error: error.message }); }
};
