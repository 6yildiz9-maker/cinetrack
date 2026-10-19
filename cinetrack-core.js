// CineTrack çekirdek mantığı: hem tarayıcıdan (klasik script) hem testlerden (node:vm) yüklenir.
(() => {
  "use strict";

  const REMINDER_WINDOW_DAYS = 3;

  function validItemId(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
    return typeof value === "string" &&
      (/^[1-9]\d{0,11}$/.test(value) || /^custom-[A-Za-z0-9_-]{1,80}$/.test(value));
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function safeHttpsUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function isValidCalendarDate(airDate) {
    const parsed = new Date(`${airDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return false;
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}` === airDate;
  }

  function sanitizeNextEpisode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const airDate = typeof value.air_date === "string" && isValidCalendarDate(value.air_date) ? value.air_date : "";
    if (!airDate) return null;
    const integerAtLeastZero = (input) => {
      const numeric = Number(input);
      return Number.isFinite(numeric) && numeric >= 0 ? Math.min(10000, Math.floor(numeric)) : 0;
    };
    return {
      air_date: airDate,
      episode_number: integerAtLeastZero(value.episode_number),
      season_number: integerAtLeastZero(value.season_number)
    };
  }

  function sanitizeSeasonMap(value, { maxSeason = 300, maxValue = 10000, allowZero = true } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const output = {};
    for (const [key, rawCount] of Object.entries(value)) {
      const season = Number(key);
      if (!Number.isSafeInteger(season) || season < 1 || season > maxSeason) continue;
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count < 0 || (!allowZero && count < 1)) continue;
      output[season] = Math.min(maxValue, Math.floor(count));
    }
    return output;
  }

  function sanitizeSeasonProgress(value) {
    return sanitizeSeasonMap(value, { maxSeason: 300, maxValue: 10000, allowZero: true });
  }

  function sanitizeSeasonCounts(value) {
    return sanitizeSeasonMap(value, { maxSeason: 300, maxValue: 10000, allowZero: true });
  }

  function buildSeasonCounts(details) {
    const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
    const counts = {};
    for (const season of seasons) {
      const number = Number(season?.season_number);
      if (!Number.isSafeInteger(number) || number < 1 || number > 300) continue;
      const count = Number(season?.episode_count);
      counts[number] = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 10000) : 0;
    }
    return counts;
  }

  function defaultCurrentSeason(progress, counts = {}) {
    const seasons = [...new Set([
      ...Object.keys(progress || {}).map(Number),
      ...Object.keys(counts || {}).map(Number)
    ])].filter((season) => Number.isSafeInteger(season) && season >= 1).sort((a, b) => a - b);
    if (!seasons.length) return 1;
    const watched = (season) => (progress || {})[season] || 0;
    const totalOf = (season) => {
      const value = Number((counts || {})[season]);
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    };
    const partiallyWatched = seasons.find((season) => {
      const total = totalOf(season);
      return total !== null && watched(season) > 0 && watched(season) < total;
    });
    if (partiallyWatched) return partiallyWatched;
    const queuedZero = [...seasons].reverse().find((season) =>
      watched(season) === 0 && seasons.some((previous) => previous < season && watched(previous) > 0));
    if (queuedZero) return queuedZero;
    const started = [...seasons].reverse().find((season) => watched(season) > 0);
    return started || seasons[0];
  }

  function normalizeSavedItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (!validItemId(item.id) || !["movie", "tv"].includes(item.media_type)) return null;
    const rating = Number(item.personal_rating);
    const validRating = Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : 0;
    const numeric = (value, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : 0;
    let seasonProgress = sanitizeSeasonProgress(item.season_progress) || {};
    if (!Object.keys(seasonProgress).length) {
      const legacySeason = numeric(item.current_season, 0, 300) || 1;
      const legacyWatched = numeric(item.episodes_watched, 0, 10000);
      seasonProgress = legacyWatched > 0 ? { [legacySeason]: legacyWatched } : {};
    }
    const totalWatched = Object.values(seasonProgress).reduce((sum, count) => sum + count, 0);
    const seasonCounts = sanitizeSeasonCounts(item.season_episode_counts) || {};
    return {
      id: typeof item.id === "string" && /^\d+$/.test(item.id) ? Number(item.id) : item.id,
      media_type: item.media_type,
      title: String(item.title || item.name || "Başlıksız içerik").slice(0, 160),
      release_date: typeof (item.release_date || item.releaseDate) === "string" ? (item.release_date || item.releaseDate).slice(0, 10) : "",
      first_air_date: typeof item.first_air_date === "string" ? item.first_air_date.slice(0, 10) : "",
      last_air_date: typeof item.last_air_date === "string" ? item.last_air_date.slice(0, 10) : "",
      vote_average: Number(item.vote_average ?? (Number.parseFloat(item.rating) || 0)) || 0,
      vote_count: Number(item.vote_count) || 0,
      popularity: Number(item.popularity) || 0,
      poster_url: safeHttpsUrl(item.poster_url || item.poster),
      poster_path: typeof item.poster_path === "string" ? item.poster_path : "",
      backdrop_path: typeof item.backdrop_path === "string" ? item.backdrop_path : "",
      overview: typeof item.overview === "string" ? item.overview.slice(0, 5000) : "",
      genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids.filter((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0).map(Number) : [],
      genres: Array.isArray(item.genres) ? item.genres.map((genre) => typeof genre === "string" ? genre : genre?.name).filter((name) => typeof name === "string").slice(0, 12) : [],
      runtime: Number(item.runtime) || 0,
      episode_run_time: Array.isArray(item.episode_run_time) ? item.episode_run_time.filter((value) => Number.isFinite(Number(value))).map(Number).slice(0, 5) : [],
      number_of_seasons: numeric(item.number_of_seasons, 0, 300),
      number_of_episodes: numeric(item.number_of_episodes, 0, 10000),
      season_progress: seasonProgress,
      season_episode_counts: seasonCounts,
      next_episode_to_air: sanitizeNextEpisode(item.next_episode_to_air),
      current_season: numeric(item.current_season, 0, 300) || defaultCurrentSeason(seasonProgress, seasonCounts),
      episodes_watched: totalWatched,
      next_episode: numeric(item.next_episode, 0, 10000),
      status: ["watching", "watchlist", "completed"].includes(item.status) ? item.status : "watchlist",
      personal_rating: validRating || "",
      personal_rating_cleared: validRating ? false : item.personal_rating_cleared === true,
      addedAt: typeof item.addedAt === "string" ? item.addedAt : "",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      custom: Boolean(item.custom || String(item.id).startsWith("custom-"))
    };
  }

  function dedupeItems(items) {
    const unique = new Map();
    for (const item of items) {
      const key = `${item.media_type}:${item.id}`;
      const existing = unique.get(key);
      if (!existing) {
        unique.set(key, item);
        continue;
      }
      const existingTime = existing.updatedAt || existing.addedAt || "";
      const incomingTime = item.updatedAt || item.addedAt || "";
      const newest = incomingTime > existingTime ? item : existing;
      const older = newest === item ? existing : item;
      // Yeni kayıttaki boş puan yalnızca bilinçli temizleme ise geçerli sayılır;
      // aksi hâlde eksik veridir ve eski puan korunur.
      let rating = newest.personal_rating;
      let ratingCleared = newest.personal_rating_cleared === true;
      if (!rating && !ratingCleared && older.personal_rating !== "" && Number(older.personal_rating) > 0) {
        rating = older.personal_rating;
      }
      if (rating) ratingCleared = false;
      unique.set(key, normalizeSavedItem({
        ...newest,
        status: newest.status,
        personal_rating: rating || "",
        personal_rating_cleared: ratingCleared,
        season_progress: { ...older.season_progress, ...newest.season_progress },
        season_episode_counts: { ...older.season_episode_counts, ...newest.season_episode_counts },
        next_episode_to_air: sanitizeNextEpisode(newest.next_episode_to_air) || sanitizeNextEpisode(older.next_episode_to_air),
        addedAt: [existing.addedAt, item.addedAt].filter(Boolean).sort()[0] || "",
        updatedAt: newest.updatedAt || newest.addedAt || ""
      }));
    }
    return [...unique.values()];
  }

  function parseBackupText(text) {
    const backup = JSON.parse(text);
    if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
      throw new Error("Bu dosya geçerli bir CineTrack yedeği değil.");
    }
    if (![1, 2].includes(backup.version) || !Array.isArray(backup.items)) {
      throw new Error("Bu dosya geçerli bir CineTrack yedeği değil.");
    }
    if (backup.items.some((item) => !item || typeof item !== "object" || !validItemId(item.id) || !["movie", "tv"].includes(item.media_type))) {
      throw new Error("Yedekte geçersiz içerik kimliği veya türü var. Güvenlik nedeniyle içe aktarma durduruldu.");
    }
    return {
      items: dedupeItems(backup.items.map(normalizeSavedItem).filter(Boolean)),
      profileName: typeof backup.profileName === "string" ? backup.profileName.trim().slice(0, 40) : "",
      preferences: backup.preferences && typeof backup.preferences === "object" && !Array.isArray(backup.preferences) ? backup.preferences : null
    };
  }

  const PROFILE_ID_PATTERN = /^profile-[A-Za-z0-9_-]{1,60}$/;
  const DISLIKED_KEY_PATTERN = /^(?:movie|tv):(?:[1-9]\d{0,11}|custom-[A-Za-z0-9_-]{1,80})$/;

  function normalizePreferences(raw, { knownMoods = null } = {}) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      disliked: Array.isArray(source.disliked)
        ? source.disliked.filter((key) => typeof key === "string" && DISLIKED_KEY_PATTERN.test(key)).slice(-500)
        : [],
      providers: Array.isArray(source.providers)
        ? source.providers
          .filter((id) => (typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 999_999) || (typeof id === "string" && /^\d{1,6}$/.test(id)))
          .map(String)
          .slice(-20)
        : [],
      mood: typeof source.mood === "string"
        ? (knownMoods ? (knownMoods.includes(source.mood) ? source.mood : "") : source.mood.slice(0, 20))
        : "",
      reminders: source.reminders === true,
      notified: Array.isArray(source.notified)
        ? source.notified.filter((key) => typeof key === "string" && key.length <= 200).slice(-200)
        : []
    };
  }

  function normalizeProfile(raw, { maxItems = 5000, knownMoods = null } = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.id !== "string" || !PROFILE_ID_PATTERN.test(raw.id)) return null;
    const items = Array.isArray(raw.items) ? raw.items.map(normalizeSavedItem).filter(Boolean) : [];
    return {
      id: raw.id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "Profilim",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt.slice(0, 40) : "",
      preferences: normalizePreferences(raw.preferences, { knownMoods }),
      items: dedupeItems(items).slice(0, maxItems)
    };
  }

  function normalizeDataDocument(raw, { maxProfiles = 20, maxItems = 5000 } = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    let candidates;
    let activeCandidate = "";
    if (Array.isArray(raw.profiles)) {
      candidates = raw.profiles;
      activeCandidate = typeof raw.activeProfileId === "string" ? raw.activeProfileId : "";
    } else if (Array.isArray(raw.items)) {
      // Eski sunucu dosyası (v1) ve tek profillik yedek (v2) tek profillik belgeye dönüşür.
      candidates = [{
        id: typeof raw.profileId === "string" && PROFILE_ID_PATTERN.test(raw.profileId) ? raw.profileId : "profile-default",
        name: typeof raw.profileName === "string" ? raw.profileName : "Profilim",
        createdAt: "",
        preferences: raw.preferences,
        items: raw.items
      }];
      activeCandidate = candidates[0].id;
    } else {
      return null;
    }
    const profiles = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (profiles.length >= maxProfiles) break;
      const profile = normalizeProfile(candidate, { maxItems });
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    }
    if (!profiles.length) return null;
    return {
      version: 3,
      activeProfileId: seen.has(activeCandidate) ? activeCandidate : profiles[0].id,
      profiles
    };
  }

  function resolveAirDate(item) {
    if (!item || typeof item !== "object") return "";
    if (item.media_type === "tv") {
      const next = item.next_episode_to_air;
      if (next?.air_date) return next.air_date;
      return typeof item.first_air_date === "string" ? item.first_air_date : "";
    }
    return typeof item.release_date === "string" ? item.release_date : "";
  }

  function reminderDaysUntil(airDate, today = new Date()) {
    if (typeof airDate !== "string" || !isValidCalendarDate(airDate)) return null;
    const release = new Date(`${airDate}T00:00:00`);
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.ceil((release.getTime() - startOfToday.getTime()) / 86_400_000);
    return days >= 0 && days <= REMINDER_WINDOW_DAYS ? days : null;
  }

  function createRequestGate() {
    let current = 0;
    let controller = null;
    return {
      begin() {
        current += 1;
        controller?.abort();
        controller = new AbortController();
        return { id: current, signal: controller.signal };
      },
      isCurrent(id) { return id === current; },
      invalidate() {
        current += 1;
        controller?.abort();
        controller = null;
      }
    };
  }

  const RECOMMENDATION_WEIGHTS = Object.freeze({
    genre: 0.25,
    taste: 0.2,
    actor: 0.2,
    quality: 0.15,
    crew: 0.08,
    platform: 0.07,
    exploration: 0.05
  });

  const clamp01 = (value) => Math.min(1, Math.max(0, value));

  function bayesianRating(voteAverage, voteCount, { prior = 6.5, minVotes = 300 } = {}) {
    const average = Number(voteAverage);
    const count = Number(voteCount);
    if (!Number.isFinite(average) || average <= 0) return 5.5;
    if (!Number.isFinite(count) || count <= 0) return 5.5;
    const credibility = Math.min(1, count / minVotes);
    return credibility * average + (1 - credibility) * prior;
  }

  function billingWeight(order) {
    const index = Number(order);
    if (order == null || !Number.isFinite(index) || index < 0) return 0.3;
    if (index <= 2) return 1;
    if (index <= 5) return 0.7;
    if (index <= 9) return 0.45;
    return 0.3;
  }

  // Tek bir geçmiş kaydının zevk sinyali: puan -1..1 aralığına indirgenir,
  // puan yoksa durum (tamamlandı/izliyorum) küçük pozitif katkı verir.
  function tasteValue(item) {
    if (!item || typeof item !== "object") return null;
    const rating = Number(item.personal_rating);
    if (Number.isFinite(rating) && rating >= 1) return Math.min(1, Math.max(-1, (rating - 5) / 5));
    if (item.status === "completed") return 0.4;
    if (item.status === "watching") return 0.2;
    return null;
  }

  function incrementAccumulator(accumulator, key, value, weight) {
    const entry = accumulator[key] || { name: "", num: 0, den: 0 };
    entry.num += value * weight;
    entry.den += weight;
    accumulator[key] = entry;
    return entry;
  }

  // Katman C: kullanıcı profili. cast/crew taşıyan kayıtlar oyuncu ve yönetmen
  // istatistiklerine, tümü tür yakınlığına ve film/dizi oranına katkı verir.
  function buildTasteProfile(items) {
    const actors = {};
    const directors = {};
    const genres = {};
    const typeCounts = { movie: 0, tv: 0 };
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== "object") continue;
      const value = tasteValue(item);
      if (value === null) continue;
      typeCounts[item.media_type] = (typeCounts[item.media_type] || 0) + 1;
      for (const genreId of Array.isArray(item.genre_ids) ? item.genre_ids : []) {
        incrementAccumulator(genres, genreId, value, 1);
      }
      const cast = Array.isArray(item.cast) ? item.cast : [];
      cast.forEach((person, order) => {
        const personId = person?.id;
        if (personId == null || !person.name) return;
        const weight = billingWeight(order);
        incrementAccumulator(actors, personId, value, weight).name = person.name;
        for (const genreId of Array.isArray(item.genre_ids) ? item.genre_ids : []) {
          const genreAccumulator = actors[personId].genreAccumulator || (actors[personId].genreAccumulator = {});
          incrementAccumulator(genreAccumulator, genreId, value, weight);
        }
      });
      const crew = Array.isArray(item.crew) ? item.crew : [];
      for (const member of crew) {
        if (member?.id == null || !member.name) continue;
        if (member.job !== "Director" && member.job !== "Creator") continue;
        incrementAccumulator(directors, member.id, value, 1).name = member.name;
      }
    }
    const normalize = (accumulator) => {
      const output = {};
      for (const [key, entry] of Object.entries(accumulator)) {
        const genreAccumulator = entry.genreAccumulator;
        const genreScores = {};
        if (genreAccumulator) {
          for (const [genreKey, genreEntry] of Object.entries(genreAccumulator)) {
            if (genreEntry.den <= 0) continue;
            genreScores[genreKey] = Math.min(1, Math.max(-1, genreEntry.num / genreEntry.den));
          }
        }
        output[key] = {
          name: entry.name,
          personal: entry.den > 0 ? Math.min(1, Math.max(-1, entry.num / entry.den)) : 0,
          genreScores
        };
      }
      return output;
    };
    const genreScores = {};
    for (const [key, entry] of Object.entries(genres)) {
      if (entry.den > 0) genreScores[key] = Math.min(1, Math.max(-1, entry.num / entry.den));
    }
    const total = typeCounts.movie + typeCounts.tv;
    return {
      actors: normalize(actors),
      directors: normalize(directors),
      genres: genreScores,
      mediaPreference: total ? {
        movie: (typeCounts.movie || 0) / total,
        tv: (typeCounts.tv || 0) / total
      } : { movie: 0.5, tv: 0.5 }
    };
  }

  function scoreCandidates(candidates, profile, {
    weights = RECOMMENDATION_WEIGHTS,
    preferredProviders = [],
    providerIndex = null,
    genreNames = null
  } = {}) {
    const preferred = new Set(preferredProviders.map(String));
    const likedGenres = Object.entries(profile.genres || {})
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);
    const topGenreIds = new Set(likedGenres.slice(0, 3).map(([id]) => String(id)));
    const actorOf = (personId) => profile.actors?.[personId] || null;
    const directorOf = (personId) => profile.directors?.[personId] || null;
    return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
      const genreIds = (Array.isArray(candidate.genre_ids) ? candidate.genre_ids : []).map(String);
      const cast = (Array.isArray(candidate.cast) ? candidate.cast : []).slice(0, 8);
      const crew = Array.isArray(candidate.crew) ? candidate.crew : [];

      const knownGenreScores = genreIds.map((id) => profile.genres?.[id]).filter((score) => typeof score === "number");
      const genrePart = knownGenreScores.length
        ? clamp01(knownGenreScores.reduce((sum, score) => sum + (score + 1) / 2, 0) / knownGenreScores.length)
        : 0.5;
      const mediaPart = clamp01(profile.mediaPreference?.[candidate.media_type] ?? 0.5);
      const genreScore = 0.75 * genrePart + 0.25 * mediaPart;

      let tasteScore = genrePart;
      let actorScore = 0.5;
      let unknownCast = true;
      if (cast.length) {
        let tasteNum = 0;
        let tasteDen = 0;
        let actorNum = 0;
        let actorDen = 0;
        let unknownCount = 0;
        for (const [index, person] of cast.entries()) {
          if (person?.id == null) continue;
          const weight = billingWeight(index);
          const known = actorOf(person.id);
          if (!known) unknownCount += 1;
          const personal = known ? (known.personal + 1) / 2 : 0.5;
          tasteNum += personal * weight;
          tasteDen += weight;
          const popularity = Number(person.popularity);
          const general = Number.isFinite(popularity) && popularity > 0 ? clamp01(popularity / (popularity + 100)) : 0.5;
          let personalBlend = personal;
          if (known) {
            const sharedGenre = genreIds.find((genreId) => typeof known.genreScores?.[genreId] === "number");
            if (sharedGenre) personalBlend = 0.6 * ((known.genreScores[sharedGenre] + 1) / 2) + 0.4 * personal;
          }
          actorNum += (0.4 * general + 0.6 * personalBlend) * weight;
          actorDen += weight;
        }
        if (tasteDen > 0) tasteScore = clamp01(tasteNum / tasteDen);
        if (actorDen > 0) {
          actorScore = clamp01(actorNum / actorDen);
          unknownCast = unknownCount === cast.length;
        }
      }

      const qualityScore = clamp01(bayesianRating(candidate.vote_average, candidate.vote_count) / 10);

      const directorEntry = crew.find((member) => member?.id != null && (member.job === "Director" || member.job === "Creator"));
      const knownDirector = directorEntry ? directorOf(directorEntry.id) : null;
      const crewScore = knownDirector ? clamp01((knownDirector.personal + 1) / 2) : 0.5;

      const key = `${candidate.media_type}:${candidate.id}`;
      const providers = providerIndex?.[key] || null;
      let platformScore = 0.5;
      let platformTag = "";
      if (providers) {
        const providerIds = providers.map((provider) => String(provider.id));
        const preferredHit = providerIds.filter((id) => preferred.has(id)).map((id) => providers.find((provider) => String(provider.id) === id)?.name).filter(Boolean);
        if (preferredHit.length) {
          platformScore = 1;
          platformTag = `Tercih ettiğin platformda izlenebilir: ${preferredHit.slice(0, 2).join(", ")}`;
        } else if (providerIds.length) {
          platformScore = 0.6;
          platformTag = `İzlenebilir: ${providers.slice(0, 2).map((provider) => provider.name).filter(Boolean).join(", ")}`;
        } else {
          platformScore = 0.25;
        }
      }

      const overlapWithTop = genreIds.filter((id) => topGenreIds.has(id)).length;
      const topGenreOverlap = genreIds.length ? overlapWithTop / genreIds.length : 0;
      const explorationScore = unknownCast
        ? clamp01(0.7 + 0.3 * (1 - topGenreOverlap))
        : clamp01(0.5 * (cast.length ? (cast.filter((person) => !actorOf(person?.id)).length / cast.length) : 0.5) + 0.5 * (1 - topGenreOverlap));

      const parts = {
        genre: genreScore,
        taste: tasteScore,
        actor: actorScore,
        quality: qualityScore,
        crew: crewScore,
        platform: platformScore,
        exploration: explorationScore
      };
      const total = Object.entries(weights).reduce((sum, [name, weight]) => sum + (parts[name] ?? 0.5) * weight, 0);

      const tags = [];
      if (candidate.poolReason) tags.push(candidate.poolReason);
      const bestActor = cast.map((person) => ({ person, known: actorOf(person?.id) }))
        .filter((entry) => entry.known && entry.known.personal >= 0.3)
        .sort((a, b) => b.known.personal - a.known.personal)[0];
      if (bestActor) tags.push(`Sevdiğin ${bestActor.known.name} oynuyor`);
      const bestGenre = likedGenres.find(([id]) => genreIds.includes(id));
      const bestGenreTag = bestGenre && genreNames?.[bestGenre[0]] ? `${genreNames[bestGenre[0]]} türünü sevdiğin için` : "";
      if (bestGenreTag && bestGenreTag !== candidate.poolReason) tags.push(bestGenreTag);
      if (knownDirector && knownDirector.personal >= 0.3) tags.push(`Sevdiğin yönetmen ${knownDirector.name}`);
      if (platformTag) tags.push(platformTag);
      if (qualityScore >= 0.7) tags.push(`TMDB'de ${bayesianRating(candidate.vote_average, candidate.vote_count).toFixed(1)} puan`);
      if (explorationScore >= 0.75) tags.push("Yeni keşif için");

      return { candidate, score: total, parts, tags: tags.slice(0, 4) };
    });
  }

  function diversifyList(scored, { limit = 24, maxPerGenre = 6 } = {}) {
    const ordered = [...(Array.isArray(scored) ? scored : [])].sort((a, b) => b.score - a.score);
    const dominantGenre = (entry) => (entry.candidate?.genre_ids || [])[0] != null ? String(entry.candidate.genre_ids[0]) : "";
    const picked = [];
    const counts = {};
    for (const entry of ordered) {
      if (picked.length >= limit) break;
      const genre = dominantGenre(entry);
      if (genre && (counts[genre] || 0) >= maxPerGenre) continue;
      picked.push(entry);
      if (genre) counts[genre] = (counts[genre] || 0) + 1;
    }
    return picked;
  }

  function createCandidatePool({ maxItems = 2000 } = {}) {
    const map = new Map();
    return {
      add(source, reason, mediaTypeGuess, items) {
        for (const item of Array.isArray(items) ? items : []) {
          if (!item || typeof item !== "object" || item.id == null) continue;
          const mediaType = item.media_type === "movie" || item.media_type === "tv" ? item.media_type : mediaTypeGuess;
          if (mediaType !== "movie" && mediaType !== "tv") continue;
          const key = `${mediaType}:${item.id}`;
          const existing = map.get(key);
          if (existing) {
            existing.poolSources += 1;
            continue;
          }
          if (map.size >= maxItems) continue;
          map.set(key, {
            ...item,
            media_type: mediaType,
            poolSource: source,
            poolReason: reason || "",
            poolSources: 1
          });
        }
      },
      get size() { return map.size; },
      list() { return [...map.values()]; }
    };
  }

  globalThis.CineTrackCore = {
    REMINDER_WINDOW_DAYS,
    validItemId,
    escapeHTML,
    sanitizeNextEpisode,
    sanitizeSeasonProgress,
    sanitizeSeasonCounts,
    buildSeasonCounts,
    defaultCurrentSeason,
    normalizeSavedItem,
    dedupeItems,
    parseBackupText,
    normalizePreferences,
    normalizeProfile,
    normalizeDataDocument,
    RECOMMENDATION_WEIGHTS,
    bayesianRating,
    billingWeight,
    buildTasteProfile,
    scoreCandidates,
    diversifyList,
    createCandidatePool,
    resolveAirDate,
    reminderDaysUntil,
    createRequestGate
  };
})();
