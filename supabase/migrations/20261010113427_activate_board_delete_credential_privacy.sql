BEGIN;
-- 2단계: 새 삭제 API가 배포된 뒤 실행한다. 기존 SELECT * 화면의 열은 유지한다.
LOCK TABLE public.posts, public.comments IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO public.board_post_delete_credentials(post_id,password_hash)
SELECT id,password_hash FROM public.posts WHERE password_hash IS NOT NULL
ON CONFLICT(post_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
INSERT INTO public.board_comment_delete_credentials(comment_id,password_hash)
SELECT id,password_hash FROM public.comments WHERE password_hash IS NOT NULL
ON CONFLICT(comment_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

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
  NEW.password_hash := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.store_board_delete_credential() FROM PUBLIC, anon, authenticated;


DROP TRIGGER IF EXISTS store_board_post_delete_credential ON public.posts;
CREATE TRIGGER store_board_post_delete_credential BEFORE INSERT OR UPDATE OF password_hash ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.store_board_delete_credential();
DROP TRIGGER IF EXISTS store_board_comment_delete_credential ON public.comments;
CREATE TRIGGER store_board_comment_delete_credential BEFORE INSERT OR UPDATE OF password_hash ON public.comments
FOR EACH ROW EXECUTE FUNCTION public.store_board_delete_credential();

UPDATE public.posts SET password_hash = NULL WHERE password_hash IS NOT NULL;
UPDATE public.comments SET password_hash = NULL WHERE password_hash IS NOT NULL;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_delete_hash_private;
ALTER TABLE public.posts ADD CONSTRAINT posts_delete_hash_private CHECK(password_hash IS NULL);
ALTER TABLE public.comments DROP CONSTRAINT IF EXISTS comments_delete_hash_private;
ALTER TABLE public.comments ADD CONSTRAINT comments_delete_hash_private CHECK(password_hash IS NULL);

COMMIT;
