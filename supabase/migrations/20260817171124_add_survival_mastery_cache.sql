-- PUBG Survival Mastery is account-level data, not season stats. Keep it beside
-- the existing player cache so normal page loads can reuse it without another API call.
ALTER TABLE public.pubg_player_cache
  ADD COLUMN IF NOT EXISTS survival_mastery_data jsonb,
  ADD COLUMN IF NOT EXISTS survival_mastery_updated_at timestamptz;

COMMENT ON COLUMN public.pubg_player_cache.survival_mastery_data IS
  'Cached PUBG Survival Mastery attributes: xp, tier, level, totalMatchesPlayed.';
COMMENT ON COLUMN public.pubg_player_cache.survival_mastery_updated_at IS
  'Last attempted PUBG Survival Mastery fetch; used for the account-level cache TTL.';
