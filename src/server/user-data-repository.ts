import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DataDocument, Profile, SavedItem } from '../core/cinetrack-core.ts';

export interface SnapshotMetadata {
  id: string;
  createdAt: string;
  revision: number;
  profilesCount: number;
  itemsCount: number;
}

export interface UserDataRepository {
  load(): Promise<unknown | null>;
  save(args: {
    document: DataDocument;
    snapshot: DataDocument | null;
    keepSnapshots: number;
  }): Promise<void>;
  createSnapshot(snapshot: DataDocument, keepSnapshots: number): Promise<void>;
  listSnapshots(): Promise<SnapshotMetadata[]>;
  getSnapshot(id: string): Promise<unknown | null>;
}

interface ProfileRow {
  id: string;
  name: string;
  is_demo: boolean;
  preferences: Profile['preferences'];
  favorite_actors: Profile['favoriteActors'];
  deleted_keys: Profile['deleted_keys'] | Record<string, unknown>;
  created_label: string;
  position: number;
}

interface ItemRow {
  profile_id: string;
  item_key: string;
  media_type: 'movie' | 'tv';
  tmdb_id: number | null;
  status: SavedItem['status'];
  title: string;
  personal_rating: number | null;
  is_custom: boolean;
  payload: SavedItem;
  added_at: string | null;
  position: number;
}

function countItems(doc: DataDocument): number {
  return doc.profiles.reduce((sum, p) => sum + (p.items?.length ?? 0), 0);
}

const NUMERIC_ID_PATTERN = /^[1-9]\d{0,17}$/;
const NUMERIC_RATING_PATTERN = /^-?\d+(\.\d+)?$/;

function toProfileRow(profile: Profile, position: number): ProfileRow {
  return {
    id: profile.id,
    name: profile.name,
    is_demo: Boolean(profile.isDemo),
    preferences: profile.preferences,
    favorite_actors: profile.favoriteActors ?? [],
    deleted_keys: profile.deleted_keys ?? {},
    created_label: profile.createdAt ?? '',
    position,
  };
}

function toItemRow(profileId: string, item: SavedItem, position: number): ItemRow {
  const idText = String(item.id);
  const numericId = NUMERIC_ID_PATTERN.test(idText) ? Number(idText) : null;
  const rating =
    item.personal_rating !== null && item.personal_rating !== undefined && NUMERIC_RATING_PATTERN.test(String(item.personal_rating))
      ? Number(item.personal_rating)
      : null;
  const addedAt = item.addedAt && !Number.isNaN(Date.parse(item.addedAt)) ? new Date(item.addedAt).toISOString() : null;
  return {
    profile_id: profileId,
    item_key: `${item.media_type}:${idText}`,
    media_type: item.media_type,
    tmdb_id: numericId,
    status: item.status,
    title: String(item.title ?? ''),
    personal_rating: rating,
    is_custom: Boolean(item.custom),
    payload: item,
    added_at: addedAt,
    position,
  };
}

function stateOf(doc: DataDocument) {
  return {
    schemaVersion: doc.schemaVersion,
    engineVersion: doc.engineVersion,
    activeProfileId: doc.activeProfileId,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
  };
}

export function createSupabaseUserDataRepository(client: SupabaseClient): UserDataRepository {
  return {
    async load() {
      const { data, error } = await client.rpc('load_user_document');
      if (error) throw new Error(`Kullanıcı verisi okunamadı: ${error.message}`);
      return data ?? null;
    },

    async save({ document, snapshot, keepSnapshots }) {
      const profiles = document.profiles.map((p, i) => toProfileRow(p, i));
      const items = document.profiles.flatMap((p) =>
        (p.items ?? []).map((item, i) => toItemRow(p.id, item, i))
      );
      const { error } = await client.rpc('save_user_document', {
        p_state: stateOf(document),
        p_profiles: profiles,
        p_items: items,
        p_snapshot: snapshot,
        p_keep: keepSnapshots,
      });
      if (error) throw new Error(`Kullanıcı verisi kaydedilemedi: ${error.message}`);
    },

    async createSnapshot(snapshot, keepSnapshots) {
      const { error: insertError } = await client.from('data_snapshots').insert({
        revision: snapshot.revision,
        profiles_count: snapshot.profiles.length,
        items_count: countItems(snapshot),
        document: snapshot,
      });
      if (insertError) throw new Error(`Yedek oluşturulamadı: ${insertError.message}`);

      const { data: stale, error: staleError } = await client
        .from('data_snapshots')
        .select('id')
        .order('created_at', { ascending: false })
        .range(Math.max(keepSnapshots, 1), 10000);
      if (staleError) throw new Error(`Eski yedekler okunamadı: ${staleError.message}`);
      const staleIds = (stale ?? []).map((row) => row.id);
      if (staleIds.length > 0) {
        const { error: deleteError } = await client.from('data_snapshots').delete().in('id', staleIds);
        if (deleteError) throw new Error(`Eski yedekler silinemedi: ${deleteError.message}`);
      }
    },

    async listSnapshots() {
      const { data, error } = await client
        .from('data_snapshots')
        .select('id, created_at, revision, profiles_count, items_count')
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Yedekler okunamadı: ${error.message}`);
      return (data ?? []).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        revision: Number(row.revision),
        profilesCount: Number(row.profiles_count),
        itemsCount: Number(row.items_count),
      }));
    },

    async getSnapshot(id) {
      const { data, error } = await client
        .from('data_snapshots')
        .select('document')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Yedek okunamadı: ${error.message}`);
      return data?.document ?? null;
    },
  };
}

export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
