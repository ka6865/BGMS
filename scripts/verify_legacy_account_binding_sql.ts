// Synthetic PostgreSQL scenarios only. Pipe into the existing disposable migration-check database.
import { proveLegacyAccountBinding, buildLegacyAccountBindingSql } from "../lib/pubg-analysis/legacyAccountBinding";

const rows = ["a", "b"].map((suffix, index) => ({
  match_id: "00000000-0000-0000-0000-000000000001", platform: "steam", player_id: `legacy_binding_${suffix}`,
  account_id: null, played_at: "2026-08-01T00:00:00+00:00", game_mode: "squad-fpp", map_name: "Baltic_Main",
  kills: index, damage: 123, win_place: 5,
}));
const sources = rows.map((row, index) => ({ match_id: row.match_id, platform: row.platform, player_id: row.player_id,
  data: { fullResult: { matchId: row.match_id, platform: row.platform, player_id: row.player_id,
    createdAt: row.played_at, gameMode: row.game_mode, mapName: "에란겔",
    stats: { name: row.player_id, playerId: `account.synthetic-${index}`, kills: row.kills, damageDealt: 123.7, winPlace: 5 } } },
}));
const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
const plan = buildLegacyAccountBindingSql(rows.map(row => proveLegacyAccountBinding(row, sources, rows)))
  .replaceAll("public.pubg_player_matches", "legacy_binding_check.pubg_player_matches")
  .replaceAll("public.processed_match_telemetry", "legacy_binding_check.processed_match_telemetry");
const failPlan = `DO $check$ BEGIN
  BEGIN EXECUTE ${quote(plan)};
    RAISE EXCEPTION 'expected conflict was not raised';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'legacy-binding-current-snapshot-conflict' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches WHERE player_id LIKE 'legacy_binding_%' AND account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'partial repair escaped rollback';
  END IF;
END $check$;`;
console.log(`BEGIN;
CREATE SCHEMA legacy_binding_check;
CREATE TABLE legacy_binding_check.pubg_player_matches (
  match_id text, platform text, player_id text, account_id text, played_at timestamptz,
  game_mode text, map_name text, kills integer, damage integer, win_place integer,
  PRIMARY KEY (player_id, platform, match_id)
);
CREATE TABLE legacy_binding_check.processed_match_telemetry (
  match_id text, platform text, player_id text, data jsonb, PRIMARY KEY (match_id, platform, player_id)
);
INSERT INTO legacy_binding_check.pubg_player_matches
  SELECT * FROM jsonb_populate_recordset(NULL::legacy_binding_check.pubg_player_matches, ${quote(JSON.stringify(rows))}::jsonb);
INSERT INTO legacy_binding_check.processed_match_telemetry
  SELECT * FROM jsonb_populate_recordset(NULL::legacy_binding_check.processed_match_telemetry, ${quote(JSON.stringify(sources))}::jsonb);
${plan}
DO $check$ BEGIN
  IF (SELECT count(*) FROM legacy_binding_check.pubg_player_matches WHERE account_id IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'expected two linked records';
  END IF;
  IF EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches m
    WHERE to_jsonb(m) - 'account_id' NOT IN (SELECT to_jsonb(r) - 'account_id' FROM jsonb_populate_recordset(
      NULL::legacy_binding_check.pubg_player_matches, ${quote(JSON.stringify(rows))}::jsonb) r)) THEN
    RAISE EXCEPTION 'repair modified observed data';
  END IF;
END $check$;
UPDATE legacy_binding_check.pubg_player_matches SET account_id = NULL;
UPDATE legacy_binding_check.pubg_player_matches SET kills = 99 WHERE player_id = 'legacy_binding_b';
${failPlan}
UPDATE legacy_binding_check.pubg_player_matches SET kills = 1 WHERE player_id = 'legacy_binding_b';
UPDATE legacy_binding_check.processed_match_telemetry SET data = data || '{"changed":true}'::jsonb WHERE player_id = 'legacy_binding_b';
${failPlan}
UPDATE legacy_binding_check.processed_match_telemetry SET data = data - 'changed';
INSERT INTO legacy_binding_check.pubg_player_matches
  SELECT match_id, platform, 'collision', 'account.synthetic-0', played_at, game_mode, map_name, kills, damage, win_place
  FROM legacy_binding_check.pubg_player_matches LIMIT 1;
${failPlan}
ROLLBACK;
SELECT 'legacy account binding SQL scenarios passed' AS result;`);
