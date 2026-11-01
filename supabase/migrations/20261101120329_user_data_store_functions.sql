/*
# User data storage functions and snapshot table

CineTrack now keeps the user's profiles, saved titles, and automatic backups in the database instead of local files. This migration adds the pieces that make that work safely.

1. New Tables
- `data_snapshots`: automatic backups of the full user data taken before each save. Keeps the newest copies only; older ones are removed when a new one is added.

2. Modified Tables
- `profiles`: adds `position` (order shown in the profile list) and `created_label` (the original creation text, kept so it round-trips exactly).
- `saved_items`: adds `position` (order of items within a profile).

3. New Functions
- `load_user_document()`: returns the whole user data set as one document.
- `save_user_document(...)`: replaces the stored user data and, if given, stores a backup of the previous state. Everything happens in one transaction, so a failed save leaves the old data untouched.

4. Security
- Row level security is enabled on `data_snapshots`.
- Public roles (`anon`, `authenticated`) get no access to the new table or functions. Only `service_role` (the server) can use them.

5. Important Notes
- All statements are idempotent (IF NOT EXISTS, CREATE OR REPLACE), so the migration is safe to re-apply.
- Existing rows keep their data; new columns default to 0 or empty text until the next save fills them in.
*/

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS created_label text NOT NULL DEFAULT '';
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS data_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 0,
  profiles_count integer NOT NULL DEFAULT 0,
  items_count integer NOT NULL DEFAULT 0,
  document jsonb NOT NULL
);

ALTER TABLE data_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON data_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON data_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.load_user_document()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'schemaVersion', s.schema_version,
    'engineVersion', s.engine_version,
    'activeProfileId', COALESCE(s.active_profile_id, ''),
    'revision', s.revision,
    'updatedAt', s.updated_at,
    'profiles', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'createdAt', p.created_label,
          'isDemo', p.is_demo,
          'preferences', p.preferences,
          'favoriteActors', p.favorite_actors,
          'deleted_keys', p.deleted_keys,
          'items', COALESCE((
            SELECT jsonb_agg(i.payload ORDER BY i.position)
            FROM saved_items i
            WHERE i.profile_id = p.id
          ), '[]'::jsonb)
        )
        ORDER BY p.position
      )
      FROM profiles p
    ), '[]'::jsonb)
  )
  FROM app_state s
  WHERE s.id = 1;
$$;

CREATE OR REPLACE FUNCTION public.save_user_document(
  p_state jsonb,
  p_profiles jsonb,
  p_items jsonb,
  p_snapshot jsonb,
  p_keep integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_snapshot IS NOT NULL THEN
    INSERT INTO data_snapshots (revision, profiles_count, items_count, document)
    VALUES (
      COALESCE((p_snapshot->>'revision')::bigint, 0),
      jsonb_array_length(COALESCE(p_snapshot->'profiles', '[]'::jsonb)),
      (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(p_snapshot->'profiles', '[]'::jsonb)) pr,
        jsonb_array_elements(COALESCE(pr->'items', '[]'::jsonb))),
      p_snapshot
    );
    DELETE FROM data_snapshots
    WHERE id IN (
      SELECT id FROM data_snapshots
      ORDER BY created_at DESC, id
      OFFSET GREATEST(p_keep, 1)
    );
  END IF;

  INSERT INTO app_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

  UPDATE app_state SET
    schema_version = (p_state->>'schemaVersion')::integer,
    engine_version = p_state->>'engineVersion',
    active_profile_id = NULLIF(p_state->>'activeProfileId', ''),
    revision = (p_state->>'revision')::bigint,
    updated_at = (p_state->>'updatedAt')::timestamptz
  WHERE id = 1;

  DELETE FROM profiles
  WHERE id NOT IN (SELECT r->>'id' FROM jsonb_array_elements(p_profiles) r);

  INSERT INTO profiles (id, name, is_demo, preferences, favorite_actors, deleted_keys, created_label, position, updated_at)
  SELECT r->>'id', r->>'name', (r->>'is_demo')::boolean, r->'preferences', r->'favorite_actors',
    r->'deleted_keys', r->>'created_label', (r->>'position')::integer, now()
  FROM jsonb_array_elements(p_profiles) r
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    is_demo = EXCLUDED.is_demo,
    preferences = EXCLUDED.preferences,
    favorite_actors = EXCLUDED.favorite_actors,
    deleted_keys = EXCLUDED.deleted_keys,
    created_label = EXCLUDED.created_label,
    position = EXCLUDED.position,
    updated_at = now();

  DELETE FROM saved_items
  WHERE profile_id IN (SELECT r->>'id' FROM jsonb_array_elements(p_profiles) r);

  INSERT INTO saved_items (profile_id, item_key, media_type, tmdb_id, status, title, personal_rating,
    is_custom, payload, added_at, position, updated_at)
  SELECT r->>'profile_id', r->>'item_key', r->>'media_type', (r->>'tmdb_id')::bigint, r->>'status',
    r->>'title', (r->>'personal_rating')::numeric, (r->>'is_custom')::boolean, r->'payload',
    (r->>'added_at')::timestamptz, (r->>'position')::integer, now()
  FROM jsonb_array_elements(p_items) r;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.load_user_document() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.save_user_document(jsonb, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_user_document() TO service_role;
GRANT EXECUTE ON FUNCTION public.save_user_document(jsonb, jsonb, jsonb, jsonb, integer) TO service_role;
