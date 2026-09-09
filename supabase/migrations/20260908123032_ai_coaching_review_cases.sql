CREATE TABLE IF NOT EXISTS public.ai_coaching_review_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  analysis_kind text NOT NULL CHECK (analysis_kind IN ('single','recent','squad')),
  title text NOT NULL,
  issue_type text NOT NULL,
  source_label text NOT NULL,
  evidence_text text NOT NULL,
  original_response text NOT NULL,
  displayed_response text NOT NULL,
  review jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','held','excluded')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  review_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_coaching_review_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_coaching_review_cases FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_coaching_review_cases TO service_role;
CREATE INDEX IF NOT EXISTS ai_coaching_review_cases_queue_idx
  ON public.ai_coaching_review_cases (status, analysis_kind, updated_at DESC, id);

-- Called only after the server's admin-role guard. No SECURITY DEFINER and no public RPC grant.
CREATE OR REPLACE FUNCTION public.review_ai_coaching_case(
  p_id uuid, p_revision integer, p_status text, p_review jsonb, p_actor uuid
) RETURNS SETOF public.ai_coaching_review_cases
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE field text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('pending','approved','held','excluded')
    OR p_revision IS NULL OR p_revision < 0 OR p_actor IS NULL
    OR p_review IS NULL OR jsonb_typeof(p_review) <> 'object' THEN
    RAISE EXCEPTION 'Invalid review input' USING ERRCODE = '22023';
  END IF;
  FOREACH field IN ARRAY ARRAY['allowed','forbidden','example','note'] LOOP
    IF NOT (p_review ? field) OR jsonb_typeof(p_review->field) <> 'string'
      OR length(p_review->>field) > 6000
      OR (p_status='approved' AND length(btrim(p_review->>field))=0) THEN
      RAISE EXCEPTION 'Invalid review field' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_status IN ('held','excluded') AND length(btrim(p_review->>'note'))=0 THEN
    RAISE EXCEPTION 'A review reason is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY UPDATE public.ai_coaching_review_cases AS c SET
    status=p_status, review=p_review, revision=c.revision+1, updated_at=clock_timestamp(),
    review_history=c.review_history || jsonb_build_array(jsonb_build_object(
      'status',p_status,'revision',c.revision+1,'at',clock_timestamp(),'actor',p_actor,'review',p_review
    ))
  WHERE c.id=p_id AND c.revision=p_revision RETURNING c.*;
END;
$$;
REVOKE ALL ON FUNCTION public.review_ai_coaching_case(uuid,integer,text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_ai_coaching_case(uuid,integer,text,jsonb,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
