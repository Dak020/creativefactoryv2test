do $$
begin
  if not exists (select 1 from public.trending_audios where source = 'seed_placeholder') then
    insert into public.trending_audios
      (user_id, platform, region, title, author, audio_url, duration_seconds, virality_score, trend_rate, trend_label, source)
    values
      (null, 'tiktok', 'global', 'Late Night Drive', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 300, 98, 42, '🔥 Blowing up', 'seed_placeholder'),
      (null, 'tiktok', 'global', 'Neon Skyline', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 260, 91, 18, 'Trending up', 'seed_placeholder'),
      (null, 'tiktok', 'global', 'Golden Hour', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 240, 85, 9, 'Steady climb', 'seed_placeholder'),
      (null, 'tiktok', 'usa', 'Highway Hustle', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 280, 96, 37, '🔥 USA trending', 'seed_placeholder'),
      (null, 'tiktok', 'usa', 'Corner Store Groove', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 250, 88, 21, 'Trending up', 'seed_placeholder'),
      (null, 'tiktok', 'usa', 'Backseat Anthem', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', 270, 79, 6, 'Steady climb', 'seed_placeholder');
  end if;
end $$;