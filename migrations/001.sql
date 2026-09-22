PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 avatar_ref TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL,
 context_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
 token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, session_id TEXT, subject_id TEXT,
 interaction_id TEXT UNIQUE, payload_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, consumer TEXT
);
CREATE TABLE IF NOT EXISTS matches (
 id TEXT PRIMARY KEY, start_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 owner_session TEXT NOT NULL, user_id TEXT REFERENCES users(id), mode TEXT NOT NULL,
 opponent TEXT NOT NULL, difficulty TEXT NOT NULL, human_side TEXT NOT NULL,
 guild_id TEXT, channel_id TEXT, launch_hash TEXT,
 cohort TEXT NOT NULL, manifest_json TEXT NOT NULL, state_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, chain_head TEXT NOT NULL, status TEXT NOT NULL,
 lease_token TEXT, lease_until INTEGER, last_commit TEXT,
 outcome_json TEXT, result_units INTEGER, eligible INTEGER NOT NULL DEFAULT 0,
 verification TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 human_deadline INTEGER, finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS active_ranked ON matches(user_id)
 WHERE mode='ranked' AND status IN ('human_turn','jev_pending','verifying');
CREATE TABLE IF NOT EXISTS events (
 match_id TEXT NOT NULL REFERENCES matches(id), seq INTEGER NOT NULL, request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, kind TEXT NOT NULL, body_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(match_id,seq), UNIQUE(match_id,request_key)
);
CREATE TABLE IF NOT EXISTS operations (
 id TEXT PRIMARY KEY, match_id TEXT REFERENCES matches(id), request_id TEXT,
 kind TEXT NOT NULL, trust TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quotas (
 bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leaderboard_world ON matches(cohort,finished_at,user_id,human_side) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS leaderboard_server ON matches(guild_id,cohort,finished_at,user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS leaderboard_channel ON matches(channel_id,cohort,finished_at,user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS player_history ON matches(user_id,created_at);
CREATE INDEX IF NOT EXISTS pending_work ON matches(status,lease_until);
CREATE INDEX IF NOT EXISTS operations_match ON operations(match_id,created_at);
CREATE INDEX IF NOT EXISTS operations_kind ON operations(kind,created_at);
CREATE INDEX IF NOT EXISTS expiry_sessions ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS expiry_grants ON grants(expires_at);
