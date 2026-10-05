import { MAP_NAMES } from "./constants";

type Row = Record<string, any>;
export type LegacyAccountBinding = { before: Row; processed: Row; accountId: string };
const ACCOUNT = /^account\.[A-Za-z0-9_-]+$/;
const MATCH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = /^[a-z0-9._-]+$/;

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = parts;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (fraction && /[1-9]/.test(fraction.slice(3)))
    || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cached official base stats establish an account link, never a complete telemetry source. */
export function proveLegacyAccountBinding(before: Row, processedRows: Row[], matchRows: Row[]): LegacyAccountBinding {
  const fail = () => { throw new Error("legacy-binding-evidence-conflict"); };
  if (!MATCH.test(before.match_id) || !NAME.test(before.player_id)
    || !["steam", "kakao"].includes(before.platform) || before.account_id !== null) fail();
  const matches = matchRows.filter(row => row.match_id === before.match_id && row.platform === before.platform
    && row.player_id === before.player_id);
  const sources = processedRows.filter(row => row.match_id === before.match_id && row.platform === before.platform
    && row.player_id === before.player_id);
  if (matches.length !== 1 || sources.length !== 1) fail();
  const processed = sources[0], result = processed.data?.fullResult, stats = result?.stats;
  if (!result || result.matchId !== before.match_id || result.player_id !== before.player_id
    || result.platform !== before.platform || typeof stats?.name !== "string"
    || stats.name.toLowerCase() !== before.player_id) fail();
  if (typeof stats.playerId !== "string" || !ACCOUNT.test(stats.playerId)) fail();
  const accounts = [stats.playerId, stats.accountId, result.playerId, result.accountId]
    .filter(value => value !== undefined && value !== null);
  if (!accounts.length || accounts.some(value => typeof value !== "string" || !ACCOUNT.test(value))
    || new Set(accounts).size !== 1) fail();
  const integer = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;
  if (!integer(stats.kills, 0) || !integer(stats.winPlace, 1)
    || typeof stats.damageDealt !== "number" || !Number.isFinite(stats.damageDealt) || stats.damageDealt < 0
    || stats.kills !== before.kills || stats.winPlace !== before.win_place
    || Math.floor(stats.damageDealt) !== before.damage) fail();
  const dates = [result.createdAt, result.matchInfo?.date].filter(value => value !== undefined && value !== null);
  const maps = [result.mapName, result.matchInfo?.map].filter(value => value !== undefined && value !== null);
  const modes = [result.gameMode, result.matchInfo?.mode].filter(value => value !== undefined && value !== null);
  if (timestamp(before.played_at) === null || !dates.length
    || dates.some(date => timestamp(date) === null || timestamp(date) !== timestamp(before.played_at))
    || !maps.length || maps.some(map => map !== before.map_name && map !== MAP_NAMES[before.map_name])
    || !modes.length || modes.some(mode => mode !== before.game_mode)) fail();
  const accountId = accounts[0] as string;
  if (matchRows.some(row => row.match_id === before.match_id && row.platform === before.platform
    && row.account_id === accountId)) fail();
  return { before, processed, accountId };
}

/** One SQL statement: lock both snapshots, update NULL only, and roll back every row on a partial match. */
export function buildLegacyAccountBindingSql(bindings: LegacyAccountBinding[]): string {
  if (!bindings.length || bindings.length > 40) throw new Error("legacy-binding-scope-invalid");
  const quote = (value: unknown) => "E'" + JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'::jsonb";
  const identities = bindings.map(binding => [binding.before.match_id, binding.before.platform, binding.before.player_id].join("\n"));
  const accountIdentities = bindings.map(binding => [binding.before.match_id, binding.before.platform, binding.accountId].join("\n"));
  if (new Set(identities).size !== bindings.length || new Set(accountIdentities).size !== bindings.length)
    throw new Error("legacy-binding-scope-invalid");
  const values = bindings.map(binding => {
    if (proveLegacyAccountBinding(binding.before, [binding.processed], [binding.before]).accountId !== binding.accountId)
      throw new Error("legacy-binding-evidence-conflict");
    return `(${quote(binding.before)}, ${quote(binding.processed)}, ${quote(binding.accountId)})`;
  }).join(",\n");
  const body = `DECLARE linked_records integer;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  -- There is no unique (match, platform, account) constraint in this legacy table.
  -- A short table lock also excludes an account collision inserted during the repair.
  LOCK TABLE public.pubg_player_matches IN SHARE ROW EXCLUSIVE MODE;
  WITH expected(before_row, processed_row, account_json) AS (VALUES\n${values}),
locked_matches AS MATERIALIZED (
  SELECT m.*, e.account_json #>> '{}' AS next_account
  FROM public.pubg_player_matches m JOIN expected e
    ON m.match_id = e.before_row->>'match_id' AND m.platform = e.before_row->>'platform'
    AND m.player_id = e.before_row->>'player_id'
  WHERE to_jsonb(m) = to_jsonb(jsonb_populate_record(NULL::public.pubg_player_matches, e.before_row)) AND m.account_id IS NULL
  ORDER BY m.match_id, m.platform, m.player_id FOR UPDATE OF m
), locked_sources AS MATERIALIZED (
  SELECT p.match_id, p.platform, p.player_id
  FROM public.processed_match_telemetry p JOIN expected e
    ON p.match_id = e.processed_row->>'match_id' AND p.platform = e.processed_row->>'platform'
    AND p.player_id = e.processed_row->>'player_id'
  WHERE to_jsonb(p) = to_jsonb(jsonb_populate_record(NULL::public.processed_match_telemetry, e.processed_row))
  ORDER BY p.match_id, p.platform, p.player_id FOR SHARE OF p
), changed AS (
  UPDATE public.pubg_player_matches m SET account_id = l.next_account
  FROM locked_matches l JOIN locked_sources p USING (match_id, platform, player_id)
  WHERE m.match_id = l.match_id AND m.platform = l.platform AND m.player_id = l.player_id
    AND m.account_id IS NULL AND to_jsonb(m) = to_jsonb(l) - 'next_account'
    AND NOT EXISTS (SELECT 1 FROM public.pubg_player_matches other
      WHERE other.match_id = m.match_id AND other.platform = m.platform AND other.account_id = l.next_account)
  RETURNING m.match_id
)
SELECT count(*)::integer INTO linked_records FROM changed;
  IF linked_records <> ${bindings.length} THEN
    RAISE EXCEPTION 'legacy-binding-current-snapshot-conflict';
  END IF;
END`;
  let delimiter = "$bgms_binding$";
  for (let suffix = 1; body.includes(delimiter); suffix++) delimiter = `$bgms_binding_${suffix}$`;
  return `DO ${delimiter}\n${body}\n${delimiter};`;
}
