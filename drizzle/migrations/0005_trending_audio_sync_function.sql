-- Curated (system-wide) trending sounds have user_id NULL, which regular
-- users cannot INSERT under RLS. This security-definer function lets a
-- signed-in user refresh the shared chart for one region.
CREATE OR REPLACE FUNCTION public.replace_trending_audios(
  _platform text,
  _region text,
  _rows jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE inserted_count integer;
BEGIN
  DELETE FROM public.trending_audios
   WHERE user_id IS NULL
     AND platform = _platform
     AND region = _region
     AND source = 'apify';

  INSERT INTO public.trending_audios (
    user_id, platform, region, title, author, audio_url, cover_url,
    duration_seconds, virality_score, trend_rate, trend_label,
    external_id, source_url, source, last_synced_at
  )
  SELECT
    NULL, _platform, _region,
    r->>'title',
    NULLIF(r->>'author', ''),
    NULLIF(r->>'audio_url', ''),
    NULLIF(r->>'cover_url', ''),
    NULLIF(r->>'duration_seconds', '')::numeric,
    COALESCE(NULLIF(r->>'virality_score', '')::numeric, 0),
    COALESCE(NULLIF(r->>'trend_rate', '')::numeric, 0),
    NULLIF(r->>'trend_label', ''),
    NULLIF(r->>'external_id', ''),
    NULLIF(r->>'source_url', ''),
    'apify',
    now()
  FROM jsonb_array_elements(_rows) AS r
  WHERE COALESCE(r->>'title', '') <> '';

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_trending_audios(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_trending_audios(text, text, jsonb) TO authenticated, service_role;

-- The broken placeholder rows seeded earlier point at a host the browser
-- cannot load, so remove them for good.
DELETE FROM public.trending_audios WHERE source = 'seed_placeholder';