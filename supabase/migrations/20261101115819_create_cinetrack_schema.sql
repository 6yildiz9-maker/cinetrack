/*
# Create CineTrack database schema

CineTrack is a personal movie and TV tracker. This migration creates the tables that hold the same information the app currently saves to its local data files: the active profile, each profile's preferences and favorite actors, every saved title with its progress and rating, the shared title catalog, and the per-profile recommendation cache.

1. New Tables
- `app_state`: a single row with the active profile, schema version, engine version, the save revision counter (used to detect conflicting saves), and last update time.
- `profiles`: one row per profile with name, creation time, preferences (JSON), favorite actors (JSON), and deleted-title markers (JSON).
- `saved_items`: one row per saved movie or show per profile. Key columns (type, TMDB id, status, title, personal rating) are real columns for filtering; the full item detail is kept in `payload` (JSON).
- `catalog_items`: shared, de-duplicated TMDB metadata for movies and shows, keyed by `media_key` such as `movie:123` or `tv:456`.
- `derived_profile_cache`: one row per profile with recommendation scores, plus the version and fingerprint fields used to decide whether the cache is still valid.

2. Modified Tables
- None. All tables are new.

3. Security
- Row level security is enabled on every table.
- All access is revoked from the public `anon` and `authenticated` roles, so the browser cannot read or write these tables directly.
- Only `service_role` is granted access. The server holds this key and enforces the app's own access token before touching data.
- No policies are created for public roles, so anything other than the server is denied by default.

4. Important Notes
- Foreign keys cascade: deleting a profile removes its saved items and cached recommendations.
- Indexes cover the common lookups: items by profile and status, items by profile and media type, and catalog items by media type.
- Every statement is idempotent (IF NOT EXISTS / DROP ... IF EXISTS), so the migration can be safely re-applied.
*/

CREATE TABLE IF NOT EXISTS app_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  schema_version integer NOT NULL DEFAULT 3,
  engine_version text,
  active_profile_id text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  id text PRIMARY KEY CHECK (id ~ '^(profile-[A-Za-z0-9_-]{1,60}|p[0-9]{1,10})$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  is_demo boolean NOT NULL DEFAULT false,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  favorite_actors jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_items (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint,
  status text NOT NULL CHECK (status IN ('watching', 'watchlist', 'completed')),
  title text NOT NULL,
  personal_rating numeric,
  is_custom boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  added_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, item_key)
);

CREATE INDEX IF NOT EXISTS saved_items_profile_status_idx ON saved_items (profile_id, status);
CREATE INDEX IF NOT EXISTS saved_items_profile_media_type_idx ON saved_items (profile_id, media_type);

CREATE TABLE IF NOT EXISTS catalog_items (
  media_key text PRIMARY KEY CHECK (media_key ~ '^(movie|tv):[1-9][0-9]{0,11}$'),
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL,
  title text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_items_media_type_idx ON catalog_items (media_type);

CREATE TABLE IF NOT EXISTS derived_profile_cache (
  profile_id text PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version integer NOT NULL,
  algorithm_version text NOT NULL,
  profile_fingerprint text NOT NULL,
  source_catalog_hash text NOT NULL,
  content_hash text NOT NULL,
  payload jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE derived_profile_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON app_state, profiles, saved_items, catalog_items, derived_profile_cache FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON app_state, profiles, saved_items, catalog_items, derived_profile_cache TO service_role;

INSERT INTO app_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
