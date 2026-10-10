BEGIN;
-- 1단계: 기존 앱의 삭제 비밀번호를 유지하며 서버 전용 저장소를 준비한다.
CREATE TABLE IF NOT EXISTS public.board_post_delete_credentials (
  post_id bigint PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.board_comment_delete_credentials (
  comment_id bigint PRIMARY KEY REFERENCES public.comments(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  password_hash text NOT NULL
);
ALTER TABLE public.board_post_delete_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board_comment_delete_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.board_post_delete_credentials, public.board_comment_delete_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.board_post_delete_credentials, public.board_comment_delete_credentials TO service_role;

CREATE OR REPLACE FUNCTION public.store_board_delete_credential()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.password_hash IS NOT NULL THEN
    IF TG_TABLE_NAME = 'posts' THEN
      INSERT INTO public.board_post_delete_credentials(post_id,password_hash)
      VALUES(NEW.id,NEW.password_hash)
      ON CONFLICT(post_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
    ELSE
      INSERT INTO public.board_comment_delete_credentials(comment_id,password_hash)
      VALUES(NEW.id,NEW.password_hash)
      ON CONFLICT(comment_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.store_board_delete_credential() FROM PUBLIC, anon, authenticated;

-- AFTER trigger는 원본 행이 생성된 뒤 FK를 가진 검증값을 저장한다.
DROP TRIGGER IF EXISTS store_board_post_delete_credential ON public.posts;
CREATE TRIGGER store_board_post_delete_credential AFTER INSERT OR UPDATE OF password_hash ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.store_board_delete_credential();
DROP TRIGGER IF EXISTS store_board_comment_delete_credential ON public.comments;
CREATE TRIGGER store_board_comment_delete_credential AFTER INSERT OR UPDATE OF password_hash ON public.comments
FOR EACH ROW EXECUTE FUNCTION public.store_board_delete_credential();

INSERT INTO public.board_post_delete_credentials(post_id,password_hash)
SELECT id,password_hash FROM public.posts WHERE password_hash IS NOT NULL
ON CONFLICT(post_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
INSERT INTO public.board_comment_delete_credentials(comment_id,password_hash)
SELECT id,password_hash FROM public.comments WHERE password_hash IS NOT NULL
ON CONFLICT(comment_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

ALTER TABLE public.board_write_rate_limits DROP CONSTRAINT IF EXISTS board_write_rate_limits_scope_check;
ALTER TABLE public.board_write_rate_limits ADD CONSTRAINT board_write_rate_limits_scope_check
CHECK(scope IN ('post','comment','post_delete','comment_delete'));

CREATE OR REPLACE FUNCTION public.consume_board_write_quota(
  p_scope text,
  p_actor_hash text,
  p_window_seconds integer,
  p_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF p_scope IS NULL
     OR p_actor_hash IS NULL
     OR p_window_seconds IS NULL
     OR p_limit IS NULL
     OR p_scope NOT IN ('post', 'comment', 'post_delete', 'comment_delete')
     OR p_actor_hash !~ '^[a-f0-9]{64}$'
     OR p_window_seconds NOT BETWEEN 1 AND 3600
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN false;
  END IF;

  INSERT INTO public.board_write_rate_limits AS current_limit (
    scope,
    actor_hash,
    window_started_at,
    request_count
  ) VALUES (
    p_scope,
    p_actor_hash,
    statement_timestamp(),
    1
  )
  ON CONFLICT (scope, actor_hash) DO UPDATE
  SET
    window_started_at = CASE
      WHEN current_limit.window_started_at
        <= statement_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
        THEN statement_timestamp()
      ELSE current_limit.window_started_at
    END,
    request_count = CASE
      WHEN current_limit.window_started_at
        <= statement_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
        THEN 1
      ELSE current_limit.request_count + 1
    END
  WHERE current_limit.window_started_at
      <= statement_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
     OR current_limit.request_count < p_limit
  RETURNING true INTO v_allowed;

  RETURN COALESCE(v_allowed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_board_write_quota(text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_board_write_quota(text, text, integer, integer)
  TO service_role;


COMMIT;
