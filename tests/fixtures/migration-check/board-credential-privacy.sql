BEGIN;
DO $$
BEGIN
  IF (SELECT password_hash FROM public.posts WHERE id=99991001) IS NOT NULL
     OR (SELECT password_hash FROM public.comments WHERE id=99991001) IS NOT NULL
     OR (SELECT password_hash FROM public.board_post_delete_credentials WHERE post_id=99991001) IS DISTINCT FROM 'legacy-post-hash'
     OR (SELECT password_hash FROM public.board_comment_delete_credentials WHERE comment_id=99991001) IS DISTINCT FROM 'legacy-comment-hash' THEN
    RAISE EXCEPTION 'Activation lost or exposed legacy credentials';
  END IF;
  IF has_table_privilege('anon','public.board_post_delete_credentials','SELECT')
     OR has_table_privilege('authenticated','public.board_comment_delete_credentials','SELECT')
     OR NOT has_table_privilege('service_role','public.board_post_delete_credentials','SELECT') THEN
    RAISE EXCEPTION 'Credential table ACL mismatch';
  END IF;
END;
$$;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM password_hash FROM public.board_post_delete_credentials;
    RAISE EXCEPTION 'Anonymous credential read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS(SELECT 1 FROM public.posts WHERE password_hash IS NOT NULL)
     OR EXISTS(SELECT 1 FROM public.comments WHERE password_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'Legacy public SELECT still exposes credentials';
  END IF;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
INSERT INTO public.posts(id,title,content,password_hash) VALUES(99991002,'new guest fixture','content','new-post-hash');
INSERT INTO public.comments(id,post_id,content,password_hash) VALUES(99991002,99991002,'comment','new-comment-hash');
-- BEFORE INSERT에서 만든 참조도 부모 행 등록 후 유효해야 한다.
SET CONSTRAINTS ALL IMMEDIATE;
DO $$
BEGIN
  IF (SELECT password_hash FROM public.board_post_delete_credentials WHERE post_id=99991002) IS DISTINCT FROM 'new-post-hash'
     OR (SELECT password_hash FROM public.board_comment_delete_credentials WHERE comment_id=99991002) IS DISTINCT FROM 'new-comment-hash'
     OR (SELECT password_hash FROM public.posts WHERE id=99991002) IS NOT NULL THEN
    RAISE EXCEPTION 'New guest credential was not preserved privately';
  END IF;
  IF NOT public.consume_board_write_quota('post_delete',repeat('a',64),60,5)
     OR NOT public.consume_board_write_quota('comment_delete',repeat('b',64),60,5) THEN
    RAISE EXCEPTION 'Delete quota scope unavailable';
  END IF;
END;
$$;
DELETE FROM public.posts WHERE id=99991002;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.comments WHERE post_id=99991002)
     OR EXISTS(SELECT 1 FROM public.board_post_delete_credentials WHERE post_id=99991002)
     OR EXISTS(SELECT 1 FROM public.board_comment_delete_credentials WHERE comment_id=99991002) THEN
    RAISE EXCEPTION 'Post cascade left comments or private credentials';
  END IF;
END;
$$;
RESET ROLE;
ROLLBACK;
DELETE FROM public.posts WHERE id=99991001;
SELECT 'board credential preparation, compatibility, privacy and cascade passed' AS result;
