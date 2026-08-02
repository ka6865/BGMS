 -- supabase/migrations/20260803100000_pubg_player_matches.sql
 CREATE TABLE IF NOT EXISTS pubg_player_matches (
   player_id VARCHAR(64) NOT NULL,
   platform VARCHAR(16) NOT NULL,
   match_id VARCHAR(64) NOT NULL,
   played_at TIMESTAMPTZ NOT NULL,
   game_mode VARCHAR(32) NOT NULL,
   map_name VARCHAR(32) NOT NULL,
   kills INT NOT NULL DEFAULT 0,
   damage INT NOT NULL DEFAULT 0,
   win_place INT NOT NULL DEFAULT 99,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   PRIMARY KEY (player_id, platform, match_id)
 );
 
 CREATE INDEX IF NOT EXISTS idx_pubg_player_matches_pagination
   ON pubg_player_matches(player_id, platform, played_at DESC);
 
 ALTER TABLE pubg_player_matches ENABLE ROW LEVEL SECURITY;
 CREATE POLICY "Allow read pubg_player_matches" ON pubg_player_matches FOR SELECT USING (true);
