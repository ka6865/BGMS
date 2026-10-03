-- Account identity survives nickname changes; keep history and summary reads indexed.
set lock_timeout = '3s';
set statement_timeout = '30s';
create index if not exists idx_pubg_player_matches_account_history
  on public.pubg_player_matches (platform, account_id, played_at desc, match_id desc)
  where account_id is not null;
reset lock_timeout;
reset statement_timeout;
