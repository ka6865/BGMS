-- pg_cron/pg_net/Vault are Supabase extensions unavailable in plain PostgreSQL.
-- These fixture-only interfaces exercise our SQL, ACLs, and requests without
-- network access. Actual extension installation/HTTP delivery needs live checks.
create schema cron;
create schema net;
create schema vault;
create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true);
create table cron.job_run_details(jobid bigint,end_time timestamptz);
create function cron.schedule(text,text,text) returns bigint language sql as $$
  insert into cron.job(jobname,schedule,command) values($1,$2,$3)
  on conflict(jobname) do update set schedule=$2,command=$3,active=true returning jobid;
$$;
create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,secret text);
create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
create function vault.create_secret(text,text) returns uuid language sql as $$
  insert into vault.secrets(secret,name) values($1,$2) returning id;
$$;
create function vault.update_secret(uuid,text) returns void language sql as $$ update vault.secrets set secret=$2 where id=$1; $$;
create table net.test_requests(id bigserial primary key,url text,body jsonb,headers jsonb,timeout_milliseconds integer);
create table net._http_response(id bigint primary key,status_code integer,timed_out boolean,error_msg text,content text);
create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 1000)
returns bigint language sql as $$
  insert into net.test_requests(url,body,headers,timeout_milliseconds) values($1,$2,$4,$5) returning id;
$$;
