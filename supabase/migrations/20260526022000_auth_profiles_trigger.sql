-- 인증 트리거가 참조하는 profiles 기준선: 새 DB 재현 시 트리거보다 먼저 생성한다.
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname text UNIQUE,
  avatar_url text,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
  role text DEFAULT 'user',
  pubg_nickname text,
  pubg_platform text DEFAULT 'steam'
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can update own profile"
  ON public.profiles
  FOR UPDATE
  TO public
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "누구나 프로필 조회 가능"
  ON public.profiles
  FOR SELECT
  TO public
  USING (true);

-- Create trigger function for handling new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, nickname, avatar_url, role)
  VALUES (
    new.id,
    COALESCE(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'user_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'nickname',
      'User'
    ),
    COALESCE(
      new.raw_user_meta_data->>'avatar_url',
      new.raw_user_meta_data->>'avatar'
    ),
    'user'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger on auth.users
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill profile data for existing auth users who don't have a profile yet
INSERT INTO public.profiles (id, nickname, avatar_url, role)
SELECT 
  id,
  COALESCE(
    raw_user_meta_data->>'full_name',
    raw_user_meta_data->>'user_name',
    raw_user_meta_data->>'name',
    raw_user_meta_data->>'nickname',
    'User'
  ),
  COALESCE(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'avatar'),
  'user'
FROM auth.users
ON CONFLICT (id) DO NOTHING;
