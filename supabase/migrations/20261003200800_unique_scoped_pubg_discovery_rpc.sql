set lock_timeout = '3s';
set statement_timeout = '30s';
-- Give the account-scoped RPC a unique name across all Data API versions.
alter function public.claim_pubg_match_discovery(integer,text,text) rename to claim_scoped_pubg_match_discovery;
reset lock_timeout;
reset statement_timeout;
