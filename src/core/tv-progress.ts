import type { SavedItem } from './cinetrack-core.ts';

export interface TvProgressSummary {
  currentSeason: number;
  currentEpisode: number;
  currentSeasonTotalEpisodes: number | null;
  watchedEpisodesCount: number;
  totalEpisodesCount: number | null;
  totalSeasonsCount: number | null;
  progressPercent: number;
  positionLabel: string;
  detailLabel: string;
  isCompleted: boolean;
}

function getPositiveInt(val: unknown): number | null {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

/**
 * Computes normalized season & episode progress for a TV SavedItem (IMP-10).
 */
export function deriveTvProgressSummary(item: SavedItem): TvProgressSummary {
  const seasonProgress = item.season_progress || {};
  const seasonEpisodeCounts = item.season_episode_counts || {};

  const totalSeasonsCount = getPositiveInt(item.number_of_seasons);
  let totalEpisodesCount = getPositiveInt(item.number_of_episodes);

  if (!totalEpisodesCount) {
    const knownCounts = Object.values(seasonEpisodeCounts)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (knownCounts.length > 0) {
      totalEpisodesCount = knownCounts.reduce((sum, n) => sum + n, 0);
    }
  }

  const seasonNumbers = Object.keys(seasonProgress)
    .map(Number)
    .filter((s) => Number.isInteger(s) && s > 0)
    .sort((a, b) => a - b);

  let watchedFromMap = 0;
  let activeSeason = getPositiveInt(item.current_season) || 1;
  let activeEpisode = 0;

  if (seasonNumbers.length > 0) {
    for (const sNum of seasonNumbers) {
      const epCount = Math.max(0, Math.floor(Number(seasonProgress[sNum]) || 0));
      watchedFromMap += epCount;
    }

    // Determine active season: explicit current_season if present, else highest season with progress
    if (!getPositiveInt(item.current_season)) {
      const nonZeroSeasons = seasonNumbers.filter((s) => (Number(seasonProgress[s]) || 0) > 0);
      activeSeason =
        nonZeroSeasons.length > 0 ? nonZeroSeasons[nonZeroSeasons.length - 1] : seasonNumbers[0];
    }
    activeEpisode = Math.max(0, Math.floor(Number(seasonProgress[activeSeason]) || 0));
  } else {
    const directWatched = Math.max(0, Math.floor(Number(item.episodes_watched) || 0));
    watchedFromMap = directWatched;
    activeEpisode = directWatched;
  }

  const watchedEpisodesCount = Math.max(
    watchedFromMap,
    Math.max(0, Math.floor(Number(item.episodes_watched) || 0))
  );

  const currentSeasonTotalEpisodes = getPositiveInt(seasonEpisodeCounts[activeSeason]);
  const isCompleted =
    item.status === 'completed' ||
    (totalEpisodesCount !== null &&
      totalEpisodesCount > 0 &&
      watchedEpisodesCount >= totalEpisodesCount);

  let progressPercent = 0;
  if (item.status === 'completed') {
    progressPercent = 100;
  } else if (totalEpisodesCount && totalEpisodesCount > 0) {
    progressPercent = Math.max(
      0,
      Math.min(100, Math.round((watchedEpisodesCount / totalEpisodesCount) * 100))
    );
  } else if (currentSeasonTotalEpisodes && currentSeasonTotalEpisodes > 0) {
    progressPercent = Math.max(
      0,
      Math.min(100, Math.round((activeEpisode / currentSeasonTotalEpisodes) * 100))
    );
  } else if (watchedEpisodesCount > 0) {
    progressPercent = Math.min(92, watchedEpisodesCount * 8);
  }

  const positionLabel = `S${activeSeason} · B${activeEpisode}`;
  const detailLabel =
    totalEpisodesCount && totalEpisodesCount > 0
      ? `${Math.min(watchedEpisodesCount, totalEpisodesCount)} / ${totalEpisodesCount} bölüm`
      : currentSeasonTotalEpisodes && currentSeasonTotalEpisodes > 0
        ? `${activeEpisode} / ${currentSeasonTotalEpisodes} bölüm (S${activeSeason})`
        : watchedEpisodesCount > 0
          ? `${watchedEpisodesCount} bölüm izlendi`
          : 'Henüz başlanmadı';

  return {
    currentSeason: activeSeason,
    currentEpisode: activeEpisode,
    currentSeasonTotalEpisodes,
    watchedEpisodesCount:
      item.status === 'completed' && totalEpisodesCount
        ? Math.max(watchedEpisodesCount, totalEpisodesCount)
        : watchedEpisodesCount,
    totalEpisodesCount,
    totalSeasonsCount,
    progressPercent,
    positionLabel,
    detailLabel,
    isCompleted,
  };
}

/**
 * Advances a TV SavedItem by +1 episode, handling season rollover when season_episode_counts
 * is known and marking status='completed' if all known episodes are finished (IMP-10).
 */
export function advanceTvEpisodeProgress(
  item: SavedItem,
  nowIso: string = new Date().toISOString()
): SavedItem {
  if (item.media_type !== 'tv') return item;

  const summary = deriveTvProgressSummary(item);
  const seasonCounts = item.season_episode_counts || {};
  const nextProgress: Record<number, number> = { ...(item.season_progress || {}) };

  let targetSeason = summary.currentSeason;
  let currentSeasonWatched = Math.max(
    0,
    Math.floor(Number(nextProgress[targetSeason] ?? summary.currentEpisode) || 0)
  );
  const currentSeasonMax = getPositiveInt(seasonCounts[targetSeason]);

  // Roll over to next season if current season is already full and another season exists
  const maxSeasons =
    summary.totalSeasonsCount ||
    Math.max(
      targetSeason,
      ...Object.keys(seasonCounts)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
    );

  if (currentSeasonMax !== null && currentSeasonWatched >= currentSeasonMax && targetSeason < maxSeasons) {
    targetSeason += 1;
    currentSeasonWatched = Math.max(0, Math.floor(Number(nextProgress[targetSeason]) || 0));
  }

  const nextSeasonLimit = getPositiveInt(seasonCounts[targetSeason]);
  const updatedEpisodeInSeason =
    nextSeasonLimit !== null
      ? Math.min(nextSeasonLimit, currentSeasonWatched + 1)
      : currentSeasonWatched + 1;

  nextProgress[targetSeason] = updatedEpisodeInSeason;

  const mapTotal = Object.values(nextProgress).reduce(
    (sum, n) => sum + Math.max(0, Math.floor(Number(n) || 0)),
    0
  );
  const nextTotalWatched = Math.max(summary.watchedEpisodesCount + 1, mapTotal);
  const cappedTotalWatched =
    summary.totalEpisodesCount !== null
      ? Math.min(summary.totalEpisodesCount, nextTotalWatched)
      : nextTotalWatched;

  const reachedSeriesEnd =
    summary.totalEpisodesCount !== null &&
    summary.totalEpisodesCount > 0 &&
    cappedTotalWatched >= summary.totalEpisodesCount;

  const avgEpMinutes =
    Array.isArray(item.episode_run_time) && item.episode_run_time.length > 0 && item.episode_run_time[0] > 0
      ? item.episode_run_time[0]
      : 45;

  return {
    ...item,
    status: reachedSeriesEnd ? 'completed' : 'watching',
    current_season: targetSeason,
    episodes_watched: cappedTotalWatched,
    next_episode: updatedEpisodeInSeason + 1,
    season_progress: nextProgress,
    totalWatchTimeMinutes: cappedTotalWatched * avgEpMinutes,
    updatedAt: nowIso,
  };
}
