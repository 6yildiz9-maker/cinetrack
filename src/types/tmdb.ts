export type TmdbMediaType = 'movie' | 'tv';

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character?: string;
  order?: number;
  popularity?: number;
  profile_path?: string | null;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department?: string;
  profile_path?: string | null;
}

export interface TmdbCredits {
  cast: TmdbCastMember[];
  crew: TmdbCrewMember[];
}

export interface TmdbVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official?: boolean;
}

export interface TmdbCollectionInfo {
  id: number;
  name: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface TmdbProductionCompany {
  id: number;
  name: string;
  logo_path?: string | null;
  origin_country?: string;
}

export interface TmdbWatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
}

export interface TmdbWatchProviderRegion {
  link?: string;
  flatrate?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
}

export interface TmdbWatchProvidersResponse {
  id?: number;
  results?: Record<string, TmdbWatchProviderRegion>;
}

export interface TmdbSeasonSummary {
  id?: number;
  season_number: number;
  episode_count?: number;
  name?: string;
  air_date?: string;
  poster_path?: string | null;
}

export interface TmdbNextEpisode {
  air_date: string;
  episode_number: number;
  season_number: number;
  name?: string;
}

export interface TmdbItem {
  id: number | string;
  media_type?: TmdbMediaType | string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  poster_url?: string;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string;
  releaseDate?: string;
  status?: string;
  in_production?: boolean;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  genres?: TmdbGenre[] | string[];
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  seasons?: TmdbSeasonSummary[];
  next_episode_to_air?: TmdbNextEpisode | null;
  belongs_to_collection?: TmdbCollectionInfo | null;
  production_companies?: TmdbProductionCompany[];
  credits?: TmdbCredits;
  cast?: TmdbCastMember[];
  crew?: TmdbCrewMember[];
  videos?: {
    results: TmdbVideo[];
  };
  custom?: boolean;
  matchScore?: number;
  tasteScore?: number;
  priorityScore?: number;
  ring?: string;
  stale?: boolean;
  _source?: 'live' | 'demo' | 'stale-cache' | 'error' | 'unknown';
  _cacheStatus?: 'hit' | 'miss' | 'stale' | 'none';
}

export interface TmdbListResponse<T = TmdbItem> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
  _source?: 'live' | 'demo' | 'stale-cache' | 'error' | 'unknown';
  _cacheStatus?: 'hit' | 'miss' | 'stale' | 'none';
}

export interface TmdbGenreListResponse {
  genres: TmdbGenre[];
}

export interface TmdbPersonDetails {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  known_for_department?: string;
}

export interface TmdbPersonCreditItem extends TmdbItem {
  character?: string;
  order?: number;
  job?: string;
}

export interface TmdbPersonCombinedCredits {
  id: number;
  cast: TmdbPersonCreditItem[];
  crew: TmdbPersonCreditItem[];
}
