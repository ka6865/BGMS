-- 활성화 직전에도 기존 앱과 비밀번호가 유지되어야 한다.
INSERT INTO public.posts(id,title,content,password_hash) VALUES(99991001,'legacy fixture','content','legacy-post-hash');
INSERT INTO public.comments(id,post_id,content,password_hash) VALUES(99991001,99991001,'legacy comment','legacy-comment-hash');
DO $$
BEGIN
  IF (SELECT password_hash FROM public.posts WHERE id=99991001) IS DISTINCT FROM 'legacy-post-hash'
     OR (SELECT password_hash FROM public.board_post_delete_credentials WHERE post_id=99991001) IS DISTINCT FROM 'legacy-post-hash'
     OR (SELECT password_hash FROM public.board_comment_delete_credentials WHERE comment_id=99991001) IS DISTINCT FROM 'legacy-comment-hash' THEN
    RAISE EXCEPTION 'Preparation changed legacy deletion credentials';
  END IF;
END;
$$;
