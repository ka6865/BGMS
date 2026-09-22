-- Follow-up for environments where allow_admin_comments_on_community_drafts
-- was applied before the comment SELECT policy was tightened.
drop policy if exists "누구나 댓글 조회 가능" on public.comments;
drop policy if exists "발행 글 댓글 또는 비공개 초안 관계자만 조회" on public.comments;
create policy "발행 글 댓글 또는 비공개 초안 관계자만 조회" on public.comments
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.posts
    where posts.id = comments.post_id
      and (
        posts.status = 'published'
        or posts.user_id = (select auth.uid())
        or exists (
          select 1 from public.profiles
          where profiles.id = (select auth.uid()) and profiles.role = 'admin'
        )
      )
  )
);
