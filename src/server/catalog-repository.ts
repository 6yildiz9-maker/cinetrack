import type { SupabaseClient } from '@supabase/supabase-js';

export type CatalogMediaType = 'movie' | 'tv';

export interface CatalogRow {
  mediaKey: string;
  mediaType: CatalogMediaType;
  tmdbId: number;
  title: string;
  payload: unknown;
  fetchedAt: string;
  updatedAt: string;
}

export interface DerivedProfileRow {
  profileId: string;
  schemaVersion: number;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash: string;
  contentHash: string;
  payload: unknown;
  generatedAt: string;
}

export interface CatalogRepository {
  loadCatalogRows(mediaType: CatalogMediaType): Promise<CatalogRow[]>;
  replaceCatalogRows(mediaType: CatalogMediaType, rows: CatalogRow[]): Promise<void>;
  loadDerivedProfileRow(profileId: string): Promise<DerivedProfileRow | null>;
  upsertDerivedProfileRow(row: DerivedProfileRow): Promise<void>;
}

const UPSERT_CHUNK_SIZE = 500;

export function createSupabaseCatalogRepository(client: SupabaseClient): CatalogRepository {
  return {
    async loadCatalogRows(mediaType) {
      const rows: CatalogRow[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await client
          .from('catalog_items')
          .select('media_key, media_type, tmdb_id, title, payload, fetched_at, updated_at')
          .eq('media_type', mediaType)
          .order('media_key', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw new Error(`Katalog okunamadı: ${error.message}`);
        for (const row of data ?? []) {
          rows.push({
            mediaKey: row.media_key,
            mediaType: row.media_type,
            tmdbId: Number(row.tmdb_id),
            title: row.title,
            payload: row.payload,
            fetchedAt: row.fetched_at,
            updatedAt: row.updated_at,
          });
        }
        if (!data || data.length < pageSize) break;
      }
      return rows;
    },

    async replaceCatalogRows(mediaType, rows) {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE).map((row) => ({
          media_key: row.mediaKey,
          media_type: row.mediaType,
          tmdb_id: row.tmdbId,
          title: row.title,
          payload: row.payload,
          fetched_at: row.fetchedAt,
          updated_at: row.updatedAt,
        }));
        const { error } = await client.from('catalog_items').upsert(chunk, { onConflict: 'media_key' });
        if (error) throw new Error(`Katalog kaydedilemedi: ${error.message}`);
      }

      const keys = new Set(rows.map((row) => row.mediaKey));
      const { data: existing, error: readError } = await client
        .from('catalog_items')
        .select('media_key')
        .eq('media_type', mediaType);
      if (readError) throw new Error(`Katalog okunamadı: ${readError.message}`);
      const stale = (existing ?? []).map((row) => row.media_key).filter((key) => !keys.has(key));
      for (let i = 0; i < stale.length; i += UPSERT_CHUNK_SIZE) {
        const { error } = await client
          .from('catalog_items')
          .delete()
          .in('media_key', stale.slice(i, i + UPSERT_CHUNK_SIZE));
        if (error) throw new Error(`Eski katalog kayıtları silinemedi: ${error.message}`);
      }
    },

    async loadDerivedProfileRow(profileId) {
      const { data, error } = await client
        .from('derived_profile_cache')
        .select(
          'profile_id, schema_version, algorithm_version, profile_fingerprint, source_catalog_hash, content_hash, payload, generated_at'
        )
        .eq('profile_id', profileId)
        .maybeSingle();
      if (error) throw new Error(`Profil önbelleği okunamadı: ${error.message}`);
      if (!data) return null;
      return {
        profileId: data.profile_id,
        schemaVersion: Number(data.schema_version),
        algorithmVersion: data.algorithm_version,
        profileFingerprint: data.profile_fingerprint,
        sourceCatalogHash: data.source_catalog_hash,
        contentHash: data.content_hash,
        payload: data.payload,
        generatedAt: data.generated_at,
      };
    },

    async upsertDerivedProfileRow(row) {
      const { error } = await client.from('derived_profile_cache').upsert(
        {
          profile_id: row.profileId,
          schema_version: row.schemaVersion,
          algorithm_version: row.algorithmVersion,
          profile_fingerprint: row.profileFingerprint,
          source_catalog_hash: row.sourceCatalogHash,
          content_hash: row.contentHash,
          payload: row.payload,
          generated_at: row.generatedAt,
        },
        { onConflict: 'profile_id' }
      );
      if (error) throw new Error(`Profil önbelleği kaydedilemedi: ${error.message}`);
    },
  };
}
