BEGIN;
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
  SELECT * FROM jsonb_populate_recordset(NULL::legacy_binding_check.pubg_player_matches, '[{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":0,"damage":123,"win_place":5},{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":1,"damage":123,"win_place":5}]'::jsonb);
INSERT INTO legacy_binding_check.processed_match_telemetry
  SELECT * FROM jsonb_populate_recordset(NULL::legacy_binding_check.processed_match_telemetry, '[{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_a","playerId":"account.synthetic-0","kills":0,"damageDealt":123.7,"winPlace":5}}}},{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_b","playerId":"account.synthetic-1","kills":1,"damageDealt":123.7,"winPlace":5}}}}]'::jsonb);
DO $bgms_binding$
DECLARE linked_records integer;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  -- There is no unique (match, platform, account) constraint in this legacy table.
  -- A short table lock also excludes an account collision inserted during the repair.
  LOCK TABLE legacy_binding_check.pubg_player_matches IN SHARE ROW EXCLUSIVE MODE;
  WITH expected(before_row, processed_row, account_json) AS (VALUES
(E'{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":0,"damage":123,"win_place":5}'::jsonb, E'{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_a","playerId":"account.synthetic-0","kills":0,"damageDealt":123.7,"winPlace":5}}}}'::jsonb, E'"account.synthetic-0"'::jsonb),
(E'{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":1,"damage":123,"win_place":5}'::jsonb, E'{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_b","playerId":"account.synthetic-1","kills":1,"damageDealt":123.7,"winPlace":5}}}}'::jsonb, E'"account.synthetic-1"'::jsonb)),
locked_matches AS MATERIALIZED (
  SELECT m.*, e.account_json #>> '{}' AS next_account
  FROM legacy_binding_check.pubg_player_matches m JOIN expected e
    ON m.match_id = e.before_row->>'match_id' AND m.platform = e.before_row->>'platform'
    AND m.player_id = e.before_row->>'player_id'
  WHERE to_jsonb(m) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.pubg_player_matches, e.before_row)) AND m.account_id IS NULL
  ORDER BY m.match_id, m.platform, m.player_id FOR UPDATE OF m
), locked_sources AS MATERIALIZED (
  SELECT p.match_id, p.platform, p.player_id
  FROM legacy_binding_check.processed_match_telemetry p JOIN expected e
    ON p.match_id = e.processed_row->>'match_id' AND p.platform = e.processed_row->>'platform'
    AND p.player_id = e.processed_row->>'player_id'
  WHERE to_jsonb(p) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.processed_match_telemetry, e.processed_row))
  ORDER BY p.match_id, p.platform, p.player_id FOR SHARE OF p
), changed AS (
  UPDATE legacy_binding_check.pubg_player_matches m SET account_id = l.next_account
  FROM locked_matches l JOIN locked_sources p USING (match_id, platform, player_id)
  WHERE m.match_id = l.match_id AND m.platform = l.platform AND m.player_id = l.player_id
    AND m.account_id IS NULL AND to_jsonb(m) = to_jsonb(l) - 'next_account'
    AND NOT EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches other
      WHERE other.match_id = m.match_id AND other.platform = m.platform AND other.account_id = l.next_account)
  RETURNING m.match_id
)
SELECT count(*)::integer INTO linked_records FROM changed;
  IF linked_records <> 2 THEN
    RAISE EXCEPTION 'legacy-binding-current-snapshot-conflict';
  END IF;
END
$bgms_binding$;
DO $check$ BEGIN
  IF (SELECT count(*) FROM legacy_binding_check.pubg_player_matches WHERE account_id IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'expected two linked records';
  END IF;
  IF EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches m
    WHERE to_jsonb(m) - 'account_id' NOT IN (SELECT to_jsonb(r) - 'account_id' FROM jsonb_populate_recordset(
      NULL::legacy_binding_check.pubg_player_matches, '[{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":0,"damage":123,"win_place":5},{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":1,"damage":123,"win_place":5}]'::jsonb) r)) THEN
    RAISE EXCEPTION 'repair modified observed data';
  END IF;
END $check$;
UPDATE legacy_binding_check.pubg_player_matches SET account_id = NULL;
UPDATE legacy_binding_check.pubg_player_matches SET kills = 99 WHERE player_id = 'legacy_binding_b';
DO $check$ BEGIN
  BEGIN EXECUTE 'DO $bgms_binding$
DECLARE linked_records integer;
BEGIN
  PERFORM set_config(''lock_timeout'', ''2s'', true);
  -- There is no unique (match, platform, account) constraint in this legacy table.
  -- A short table lock also excludes an account collision inserted during the repair.
  LOCK TABLE legacy_binding_check.pubg_player_matches IN SHARE ROW EXCLUSIVE MODE;
  WITH expected(before_row, processed_row, account_json) AS (VALUES
(E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":0,"damage":123,"win_place":5}''::jsonb, E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_a","playerId":"account.synthetic-0","kills":0,"damageDealt":123.7,"winPlace":5}}}}''::jsonb, E''"account.synthetic-0"''::jsonb),
(E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":1,"damage":123,"win_place":5}''::jsonb, E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_b","playerId":"account.synthetic-1","kills":1,"damageDealt":123.7,"winPlace":5}}}}''::jsonb, E''"account.synthetic-1"''::jsonb)),
locked_matches AS MATERIALIZED (
  SELECT m.*, e.account_json #>> ''{}'' AS next_account
  FROM legacy_binding_check.pubg_player_matches m JOIN expected e
    ON m.match_id = e.before_row->>''match_id'' AND m.platform = e.before_row->>''platform''
    AND m.player_id = e.before_row->>''player_id''
  WHERE to_jsonb(m) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.pubg_player_matches, e.before_row)) AND m.account_id IS NULL
  ORDER BY m.match_id, m.platform, m.player_id FOR UPDATE OF m
), locked_sources AS MATERIALIZED (
  SELECT p.match_id, p.platform, p.player_id
  FROM legacy_binding_check.processed_match_telemetry p JOIN expected e
    ON p.match_id = e.processed_row->>''match_id'' AND p.platform = e.processed_row->>''platform''
    AND p.player_id = e.processed_row->>''player_id''
  WHERE to_jsonb(p) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.processed_match_telemetry, e.processed_row))
  ORDER BY p.match_id, p.platform, p.player_id FOR SHARE OF p
), changed AS (
  UPDATE legacy_binding_check.pubg_player_matches m SET account_id = l.next_account
  FROM locked_matches l JOIN locked_sources p USING (match_id, platform, player_id)
  WHERE m.match_id = l.match_id AND m.platform = l.platform AND m.player_id = l.player_id
    AND m.account_id IS NULL AND to_jsonb(m) = to_jsonb(l) - ''next_account''
    AND NOT EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches other
      WHERE other.match_id = m.match_id AND other.platform = m.platform AND other.account_id = l.next_account)
  RETURNING m.match_id
)
SELECT count(*)::integer INTO linked_records FROM changed;
  IF linked_records <> 2 THEN
    RAISE EXCEPTION ''legacy-binding-current-snapshot-conflict'';
  END IF;
END
$bgms_binding$;';
    RAISE EXCEPTION 'expected conflict was not raised';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'legacy-binding-current-snapshot-conflict' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches WHERE player_id LIKE 'legacy_binding_%' AND account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'partial repair escaped rollback';
  END IF;
END $check$;
UPDATE legacy_binding_check.pubg_player_matches SET kills = 1 WHERE player_id = 'legacy_binding_b';
UPDATE legacy_binding_check.processed_match_telemetry SET data = data || '{"changed":true}'::jsonb WHERE player_id = 'legacy_binding_b';
DO $check$ BEGIN
  BEGIN EXECUTE 'DO $bgms_binding$
DECLARE linked_records integer;
BEGIN
  PERFORM set_config(''lock_timeout'', ''2s'', true);
  -- There is no unique (match, platform, account) constraint in this legacy table.
  -- A short table lock also excludes an account collision inserted during the repair.
  LOCK TABLE legacy_binding_check.pubg_player_matches IN SHARE ROW EXCLUSIVE MODE;
  WITH expected(before_row, processed_row, account_json) AS (VALUES
(E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":0,"damage":123,"win_place":5}''::jsonb, E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_a","playerId":"account.synthetic-0","kills":0,"damageDealt":123.7,"winPlace":5}}}}''::jsonb, E''"account.synthetic-0"''::jsonb),
(E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":1,"damage":123,"win_place":5}''::jsonb, E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_b","playerId":"account.synthetic-1","kills":1,"damageDealt":123.7,"winPlace":5}}}}''::jsonb, E''"account.synthetic-1"''::jsonb)),
locked_matches AS MATERIALIZED (
  SELECT m.*, e.account_json #>> ''{}'' AS next_account
  FROM legacy_binding_check.pubg_player_matches m JOIN expected e
    ON m.match_id = e.before_row->>''match_id'' AND m.platform = e.before_row->>''platform''
    AND m.player_id = e.before_row->>''player_id''
  WHERE to_jsonb(m) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.pubg_player_matches, e.before_row)) AND m.account_id IS NULL
  ORDER BY m.match_id, m.platform, m.player_id FOR UPDATE OF m
), locked_sources AS MATERIALIZED (
  SELECT p.match_id, p.platform, p.player_id
  FROM legacy_binding_check.processed_match_telemetry p JOIN expected e
    ON p.match_id = e.processed_row->>''match_id'' AND p.platform = e.processed_row->>''platform''
    AND p.player_id = e.processed_row->>''player_id''
  WHERE to_jsonb(p) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.processed_match_telemetry, e.processed_row))
  ORDER BY p.match_id, p.platform, p.player_id FOR SHARE OF p
), changed AS (
  UPDATE legacy_binding_check.pubg_player_matches m SET account_id = l.next_account
  FROM locked_matches l JOIN locked_sources p USING (match_id, platform, player_id)
  WHERE m.match_id = l.match_id AND m.platform = l.platform AND m.player_id = l.player_id
    AND m.account_id IS NULL AND to_jsonb(m) = to_jsonb(l) - ''next_account''
    AND NOT EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches other
      WHERE other.match_id = m.match_id AND other.platform = m.platform AND other.account_id = l.next_account)
  RETURNING m.match_id
)
SELECT count(*)::integer INTO linked_records FROM changed;
  IF linked_records <> 2 THEN
    RAISE EXCEPTION ''legacy-binding-current-snapshot-conflict'';
  END IF;
END
$bgms_binding$;';
    RAISE EXCEPTION 'expected conflict was not raised';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'legacy-binding-current-snapshot-conflict' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches WHERE player_id LIKE 'legacy_binding_%' AND account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'partial repair escaped rollback';
  END IF;
END $check$;
UPDATE legacy_binding_check.processed_match_telemetry SET data = data - 'changed';
INSERT INTO legacy_binding_check.pubg_player_matches
  SELECT match_id, platform, 'collision', 'account.synthetic-0', played_at, game_mode, map_name, kills, damage, win_place
  FROM legacy_binding_check.pubg_player_matches LIMIT 1;
DO $check$ BEGIN
  BEGIN EXECUTE 'DO $bgms_binding$
DECLARE linked_records integer;
BEGIN
  PERFORM set_config(''lock_timeout'', ''2s'', true);
  -- There is no unique (match, platform, account) constraint in this legacy table.
  -- A short table lock also excludes an account collision inserted during the repair.
  LOCK TABLE legacy_binding_check.pubg_player_matches IN SHARE ROW EXCLUSIVE MODE;
  WITH expected(before_row, processed_row, account_json) AS (VALUES
(E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":0,"damage":123,"win_place":5}''::jsonb, E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_a","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_a","playerId":"account.synthetic-0","kills":0,"damageDealt":123.7,"winPlace":5}}}}''::jsonb, E''"account.synthetic-0"''::jsonb),
(E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","account_id":null,"played_at":"2026-08-01T00:00:00+00:00","game_mode":"squad-fpp","map_name":"Baltic_Main","kills":1,"damage":123,"win_place":5}''::jsonb, E''{"match_id":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","data":{"fullResult":{"matchId":"00000000-0000-0000-0000-000000000001","platform":"steam","player_id":"legacy_binding_b","createdAt":"2026-08-01T00:00:00+00:00","gameMode":"squad-fpp","mapName":"에란겔","stats":{"name":"legacy_binding_b","playerId":"account.synthetic-1","kills":1,"damageDealt":123.7,"winPlace":5}}}}''::jsonb, E''"account.synthetic-1"''::jsonb)),
locked_matches AS MATERIALIZED (
  SELECT m.*, e.account_json #>> ''{}'' AS next_account
  FROM legacy_binding_check.pubg_player_matches m JOIN expected e
    ON m.match_id = e.before_row->>''match_id'' AND m.platform = e.before_row->>''platform''
    AND m.player_id = e.before_row->>''player_id''
  WHERE to_jsonb(m) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.pubg_player_matches, e.before_row)) AND m.account_id IS NULL
  ORDER BY m.match_id, m.platform, m.player_id FOR UPDATE OF m
), locked_sources AS MATERIALIZED (
  SELECT p.match_id, p.platform, p.player_id
  FROM legacy_binding_check.processed_match_telemetry p JOIN expected e
    ON p.match_id = e.processed_row->>''match_id'' AND p.platform = e.processed_row->>''platform''
    AND p.player_id = e.processed_row->>''player_id''
  WHERE to_jsonb(p) = to_jsonb(jsonb_populate_record(NULL::legacy_binding_check.processed_match_telemetry, e.processed_row))
  ORDER BY p.match_id, p.platform, p.player_id FOR SHARE OF p
), changed AS (
  UPDATE legacy_binding_check.pubg_player_matches m SET account_id = l.next_account
  FROM locked_matches l JOIN locked_sources p USING (match_id, platform, player_id)
  WHERE m.match_id = l.match_id AND m.platform = l.platform AND m.player_id = l.player_id
    AND m.account_id IS NULL AND to_jsonb(m) = to_jsonb(l) - ''next_account''
    AND NOT EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches other
      WHERE other.match_id = m.match_id AND other.platform = m.platform AND other.account_id = l.next_account)
  RETURNING m.match_id
)
SELECT count(*)::integer INTO linked_records FROM changed;
  IF linked_records <> 2 THEN
    RAISE EXCEPTION ''legacy-binding-current-snapshot-conflict'';
  END IF;
END
$bgms_binding$;';
    RAISE EXCEPTION 'expected conflict was not raised';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'legacy-binding-current-snapshot-conflict' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM legacy_binding_check.pubg_player_matches WHERE player_id LIKE 'legacy_binding_%' AND account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'partial repair escaped rollback';
  END IF;
END $check$;
ROLLBACK;
SELECT 'legacy account binding SQL scenarios passed' AS result;
