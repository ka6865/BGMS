-- Lightweight match history needs official participant counters, not telemetry analysis.
-- NULL means unobserved; zero remains a real observation. Safe for older app writers.
ALTER TABLE public.pubg_player_matches
  ADD COLUMN IF NOT EXISTS knocks integer CHECK (knocks >= 0),
  ADD COLUMN IF NOT EXISTS survival_time integer CHECK (survival_time >= 0);

COMMENT ON COLUMN public.pubg_player_matches.knocks IS 'Official participant DBNOs; NULL when unobserved.';
COMMENT ON COLUMN public.pubg_player_matches.survival_time IS 'Official participant timeSurvived, floored seconds; NULL when unobserved.';

NOTIFY pgrst, 'reload schema';
