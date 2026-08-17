-- AI 요청 성공/실패와 운영 원인을 관리자 유저 관제에서 확인할 수 있도록
-- 기존 비용 로그에 요청 상태 메타데이터를 확장한다.
ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS platform text;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_status
  ON public.ai_usage_logs (created_at DESC, status);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
  ON public.ai_usage_logs (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_error_code
  ON public.ai_usage_logs (error_code, created_at DESC)
  WHERE status <> 'success';

COMMENT ON COLUMN public.ai_usage_logs.status IS
  'AI request outcome: success or error';
COMMENT ON COLUMN public.ai_usage_logs.error_message IS
  'Short sanitized operator-facing reason; never store prompts or model output here';
