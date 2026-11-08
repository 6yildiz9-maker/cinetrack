import { type Page, type Route } from '@playwright/test';

export const PROFILE_A = 'profile-e2e-a';
export const PROFILE_B = 'profile-e2e-b';

export interface SeedProfile {
  id: string;
  name: string;
  items?: Record<string, unknown>[];
}

export interface SavedItemSeed {
  id?: number;
  media_type?: 'movie' | 'tv';
  title: string;
  status?: 'watching' | 'watchlist' | 'completed';
  poster_path?: string;
  release_date?: string;
}

export function savedItem(seed: SavedItemSeed): Record<string, unknown> {
  const mediaType = seed.media_type ?? 'movie';
  return {
    id: seed.id ?? 9001,
    media_type: mediaType,
    title: seed.title,
    status: seed.status ?? 'watchlist',
    personal_rating: '',
    poster_path: seed.poster_path ?? '',
    poster_url: null,
    backdrop_path: '',
    overview: '',
    vote_average: 7.5,
    vote_count: 100,
    popularity: 10,
    genre_ids: [],
    genres: [],
    release_date: mediaType === 'movie' ? (seed.release_date ?? '2024-01-01') : '',
    first_air_date: mediaType === 'tv' ? (seed.release_date ?? '2024-01-01') : '',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function emptyPreferences(): Record<string, unknown> {
  return { disliked: [], providers: [], mood: '', reminders: false, notified: [] };
}

export function profileDocument(
  profiles: { id: string; name: string; items?: Record<string, unknown>[] }[],
  revision = 4
): Record<string, unknown> {
  return {
    version: 3,
    schemaVersion: 3,
    activeProfileId: profiles[0]?.id ?? PROFILE_A,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      createdAt: '2026-01-01T00:00:00.000Z',
      preferences: emptyPreferences(),
      items: profile.items ?? [],
      favoriteActors: [],
    })),
    revision,
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
}

export async function seedProfiles(
  page: Page,
  profiles: SeedProfile[],
  activeProfileId: string = profiles[0].id
): Promise<void> {
  await page.addInitScript(
    ({ profiles: seed, activeId }) => {
      localStorage.setItem(
        'cinetrack.profiles.v1',
        JSON.stringify(
          seed.map((profile) => ({
            id: profile.id,
            name: profile.name,
            createdAt: '2026-01-01T00:00:00.000Z',
          }))
        )
      );
      localStorage.setItem('cinetrack.activeProfile.v1', activeId);
      for (const profile of seed) {
        localStorage.setItem(
          `cinetrack.profile.${profile.id}.watchlist.v1`,
          JSON.stringify(profile.items ?? [])
        );
        localStorage.setItem(
          `cinetrack.profile.${profile.id}.preferences.v1`,
          JSON.stringify({
            disliked: [],
            providers: [],
            mood: '',
            reminders: false,
            notified: [],
          })
        );
      }
      localStorage.removeItem('cinetrack.dirty.v2');
    },
    { profiles, activeId: activeProfileId }
  );
}

export interface PutResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ApiMockControls {
  pushCount: () => number;
  requestCount: (path: string) => number;
  setPutResponder: (responder: (callIndex: number) => PutResponse) => void;
}

export interface ApiMockOptions {
  doc?: Record<string, unknown>;
  putResponder?: (callIndex: number) => PutResponse;
}

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Serves deterministic API responses so E2E runs never touch data/ on disk.
 * /api/data GET is backed by a fixture document; PUT is counted and answered locally.
 */
export async function mockApi(page: Page, options: ApiMockOptions = {}): Promise<ApiMockControls> {
  let pushCount = 0;
  let putResponder = options.putResponder;
  const requestCounts = new Map<string, number>();

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);

    if (path === '/api/data' && request.method() === 'GET') {
      return json(route, options.doc ?? profileDocument([]));
    }

    if (path === '/api/data' && request.method() === 'PUT') {
      pushCount += 1;
      const response = putResponder
        ? putResponder(pushCount)
        : { status: 200, body: { revision: 100 + pushCount, updatedAt: new Date().toISOString() } };
      return json(route, response.body, response.status);
    }

    if (path === '/api/tmdb') {
      const tmdbPath = url.searchParams.get('path') ?? '';
      const body = tmdbPath.includes('/genre/')
        ? { genres: [] }
        : { page: 1, results: [], total_pages: 0, total_results: 0 };
      return json(route, body, 200, {
        'x-cinetrack-source': 'demo',
        'x-cinetrack-cache': 'none',
      });
    }

    if (path === '/api/tmdb-status') {
      return json(route, { configured: false, source: 'demo', cacheEntries: 0 });
    }

    if (path === '/api/stock') {
      return json(route, {
        movies: [],
        tv: [],
        updatedAt: '2026-11-09T00:00:00.000Z',
        cursors: {},
      });
    }

    if (path === '/api/cinema-kunye') {
      return json(route, { version: 1, revision: 0, entries: [] });
    }

    if (path === '/api/data/backups') {
      return json(route, { backups: [] });
    }

    // Taste events, sync status and optional maintenance endpoints tolerate a neutral 200.
    return json(route, { ok: true });
  });

  return {
    pushCount: () => pushCount,
    requestCount: (path: string) => requestCounts.get(path) ?? 0,
    setPutResponder: (responder) => {
      putResponder = responder;
    },
  };
}
