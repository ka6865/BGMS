-- supabase/migrations/20260812000000_weapon_meta_snapshots.sql
CREATE TABLE IF NOT EXISTS public.weapon_meta_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patch_version text NOT NULL DEFAULT 'current',
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  weapon_category text NOT NULL,
  weapon_name text NOT NULL,
  match_count integer NOT NULL DEFAULT 0,
  active_pick_count integer NOT NULL DEFAULT 0,
  total_kills integer NOT NULL DEFAULT 0,
  total_dbnos integer NOT NULL DEFAULT 0,
  total_damage numeric(12, 2) NOT NULL DEFAULT 0,
  first_sec_hits integer NOT NULL DEFAULT 0,
  sustained_hits integer NOT NULL DEFAULT 0,
  sustained_burst_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_weapon_meta_snapshot UNIQUE (patch_version, snapshot_date, weapon_name)
);

ALTER TABLE public.weapon_meta_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.weapon_meta_snapshots TO anon, authenticated;
GRANT ALL ON public.weapon_meta_snapshots TO service_role;

CREATE INDEX IF NOT EXISTS idx_weapon_meta_snapshots_lookup
  ON public.weapon_meta_snapshots (patch_version, snapshot_date DESC, weapon_category);
