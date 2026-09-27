CREATE TABLE public.trending_audios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  platform text NOT NULL DEFAULT 'tiktok',
  region text NOT NULL DEFAULT 'global',
  title text NOT NULL,
  author text,
  audio_url text,
  storage_path text,
  cover_url text,
  duration_seconds numeric,
  virality_score numeric NOT NULL DEFAULT 0,
  trend_rate numeric NOT NULL DEFAULT 0,
  trend_label text,
  external_id text,
  source_url text,
  source text NOT NULL DEFAULT 'starter',
  is_favorite boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trending_audios TO authenticated;
GRANT ALL ON public.trending_audios TO service_role;

ALTER TABLE public.trending_audios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read shared and own audios"
  ON public.trending_audios FOR SELECT TO authenticated
  USING (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY "Insert own audios"
  ON public.trending_audios FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Update own audios"
  ON public.trending_audios FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Delete own audios"
  ON public.trending_audios FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX trending_audios_feed_idx ON public.trending_audios (platform, region, virality_score DESC);

CREATE TRIGGER trending_audios_updated_at BEFORE UPDATE ON public.trending_audios
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.generated_videos ADD COLUMN IF NOT EXISTS audio_id uuid REFERENCES public.trending_audios(id) ON DELETE SET NULL;