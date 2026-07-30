-- PUBG API 응답 분산 캐시
--
-- 배경: /api/pubg/player 의 응답 캐시와 강제 갱신 쿨다운이 인메모리 Map 이었다.
-- Vercel 서버리스에서는 함수 인스턴스마다 메모리가 분리되고 콜드 스타트로 초기화되므로
-- 캐시 히트율이 매우 낮았다. PUBG API 무료 키는 분당 10회 제한이라
-- 인스턴스가 늘어날수록 곧바로 rate limit 을 소진한다.
-- 강제 갱신 쿨다운도 인스턴스별로 따로 계산되어 실질적으로 우회 가능했다.
--
-- 이 테이블은 인스턴스 간 공유 캐시(L2) 역할을 한다.

CREATE TABLE IF NOT EXISTS public.pubg_response_cache (
  cache_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pubg_response_cache_expires_at_idx
  ON public.pubg_response_cache (expires_at);

ALTER TABLE public.pubg_response_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pubg_response_cache FROM anon, authenticated;
GRANT ALL ON TABLE public.pubg_response_cache TO service_role;

-- 강제 갱신 쿨다운 클레임 테이블
CREATE TABLE IF NOT EXISTS public.pubg_refresh_locks (
  lock_key text PRIMARY KEY,
  claimed_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.pubg_refresh_locks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pubg_refresh_locks FROM anon, authenticated;
GRANT ALL ON TABLE public.pubg_refresh_locks TO service_role;

/** 만료되지 않은 캐시 payload 를 반환합니다. 없거나 만료면 NULL. */
CREATE OR REPLACE FUNCTION public.read_pubg_response_cache(p_cache_key text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT payload
  FROM public.pubg_response_cache
  WHERE cache_key = p_cache_key
    AND expires_at > now();
$$;

/** 캐시를 기록합니다. TTL 은 1초 이상 1일 이하로 제한합니다. */
CREATE OR REPLACE FUNCTION public.write_pubg_response_cache(
  p_cache_key text,
  p_payload jsonb,
  p_ttl_seconds integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ttl integer;
BEGIN
  IF p_cache_key IS NULL OR length(p_cache_key) = 0 OR length(p_cache_key) > 300 THEN
    RETURN;
  END IF;

  ttl := least(greatest(coalesce(p_ttl_seconds, 180), 1), 86400);

  INSERT INTO public.pubg_response_cache (cache_key, payload, expires_at, updated_at)
  VALUES (p_cache_key, p_payload, now() + make_interval(secs => ttl), now())
  ON CONFLICT (cache_key) DO UPDATE
  SET payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at,
      updated_at = now();
END;
$$;

/**
 * 강제 갱신 권한을 클레임합니다.
 * 쿨다운 안에 이미 클레임이 있으면 false 를 반환합니다.
 * 인스턴스 간 경쟁 조건은 PK 충돌과 조건부 UPDATE 로 처리합니다.
 */
CREATE OR REPLACE FUNCTION public.claim_pubg_force_refresh(
  p_lock_key text,
  p_cooldown_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cooldown integer;
  updated_rows integer;
BEGIN
  IF p_lock_key IS NULL OR length(p_lock_key) = 0 OR length(p_lock_key) > 300 THEN
    RETURN false;
  END IF;

  cooldown := least(greatest(coalesce(p_cooldown_seconds, 60), 1), 3600);

  INSERT INTO public.pubg_refresh_locks (lock_key, claimed_at)
  VALUES (p_lock_key, now())
  ON CONFLICT (lock_key) DO UPDATE
  SET claimed_at = now()
  WHERE public.pubg_refresh_locks.claimed_at < now() - make_interval(secs => cooldown);

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RETURN updated_rows > 0;
END;
$$;

/** 만료된 캐시와 오래된 락을 정리합니다. 일일 유지보수 작업에서 호출합니다. */
CREATE OR REPLACE FUNCTION public.cleanup_pubg_response_cache()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.pubg_response_cache WHERE expires_at < now() - interval '1 hour';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  DELETE FROM public.pubg_refresh_locks WHERE claimed_at < now() - interval '1 day';
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.read_pubg_response_cache(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_pubg_response_cache(text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_pubg_force_refresh(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_pubg_response_cache() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.read_pubg_response_cache(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.write_pubg_response_cache(text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pubg_force_refresh(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_pubg_response_cache() TO service_role;
