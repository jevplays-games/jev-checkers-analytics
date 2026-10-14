// Browser storage keys. Typecheckers was Checkers: keys written before the rename are moved to the new
// keys once on load, so a returning player on the same origin keeps an in-progress practice match, local
// history and a pending Discord launch. A new key that already exists wins; the old key is removed either way.
export const ACTIVE_KEY='jev-typecheckers-active',HISTORY_KEY='jev-typecheckers-history',LAUNCH_KEY='typecheckers-launch';
export const LEGACY_LOCAL_KEYS=[['jev-checkers-active',ACTIVE_KEY],['jev-checkers-history',HISTORY_KEY]];
export const LEGACY_SESSION_KEYS=[['checkers-launch',LAUNCH_KEY]];
function move(storage,pairs){
  for(const [from,to] of pairs){
    try{const old=storage.getItem(from);if(old===null)continue;if(storage.getItem(to)===null)storage.setItem(to,old);storage.removeItem(from);}catch{}
  }
}
export function migrateStorage(local,session){if(local)move(local,LEGACY_LOCAL_KEYS);if(session)move(session,LEGACY_SESSION_KEYS);}
