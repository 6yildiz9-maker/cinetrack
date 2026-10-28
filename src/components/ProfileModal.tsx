import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  DataDocument,
  FavoriteActorInfo,
  Profile,
  Preferences,
  SavedItem,
} from '../core/cinetrack-core';
import {
  buildMediaJourneyTimeline,
  buildTasteDnaProfile,
  computeProfileWatchlistIntersection,
  exportItemsToCsv,
  importItemsFromCsv,
} from '../core/exporters';
import {
  createProfileBackupExport,
  downloadVerifiedBackupBinary,
  fetchServerBackups,
  fetchSyncStatus,
  inspectGitHubSync,
  pullGitHubSync,
  pushGitHubSync,
  reconcileGitHubSync,
  restoreServerBackup,
  setPublicRepoPersonalSyncConsent,
  testGitHubConnection,
  type ProfileBackupExportReportClient,
  type ServerBackupMetadata,
} from '../services/api';
import {
  deriveSyncUiBanner,
  type BidirectionalSyncReport,
  type SyncComparisonSummary,
  type SyncOperationKind,
  type SyncSideSummary,
} from '../core/sync-display';
import { PROVIDER_OPTIONS, calculateItemWatchMinutes, getTvShowEpisodesCount } from '../utils/helpers';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb } from '../core/limits';

interface ProfileModalProps {
  isOpen: boolean;
  profiles: Profile[];
  activeProfile?: Profile;
  activeProfileId: string;
  activeProfileName: string;
  preferences: Preferences;
  savedItems: SavedItem[];
  favoriteActors?: FavoriteActorInfo[];
  dislikedItems?: any[];
  genresMap: Record<number, string>;
  tasteEntries?: Record<string, any>;
  syncStatus: string;
  onClose: () => void;
  onSaveProfileName: (name: string) => void;
  onSwitchProfile: (id: string) => void;
  onCreateProfile: (name: string) => void;
  onSavePreferences: (providers: string[], mood: string) => void;
  onToggleReminders: () => void;
  onExportBackup: () => void;
  onImportBackupFile: (file: File) => void;
  onImportCsvItems?: (items: SavedItem[]) => void;
  onApplyRestoredDocument?: (doc: DataDocument) => void;
  isDemo?: boolean;
  onToggleDemoMode?: () => void;
}

function formatMinutes(totalMinutes: number): { primary: string; secondary: string; days: number; hours: number; mins: number } {
  if (totalMinutes <= 0) return { primary: '0 sa', secondary: '0 dakika', days: 0, hours: 0, mins: 0 };
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  const primary = days > 0 ? `${days}g ${hours}sa ${mins}dk` : `${hours} sa ${mins} dk`;
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const secondary = `Toplam ${totalHours} saat (${totalMinutes.toLocaleString('tr-TR')} dakika)`;
  return { primary, secondary, days, hours, mins };
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  profiles,
  activeProfile,
  activeProfileId,
  activeProfileName,
  preferences,
  savedItems,
  favoriteActors,
  dislikedItems,
  genresMap,
  tasteEntries = {},
  syncStatus,
  onClose,
  onSaveProfileName,
  onSwitchProfile,
  onCreateProfile,
  onSavePreferences,
  onToggleReminders,
  onExportBackup,
  onImportBackupFile,
  onImportCsvItems,
  onApplyRestoredDocument,
  isDemo = false,
  onToggleDemoMode,
}) => {
  const [activeTab, setActiveTab] = useState<'stats' | 'settings'>('stats');
  const [genreMediaTypeFilter, setGenreMediaTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [name, setName] = useState(activeProfileName);
  const [compareProfileId, setCompareProfileId] = useState<string>('');
  const [newProfileName, setNewProfileName] = useState('');
  const [selectedProviders, setSelectedProviders] = useState<string[]>(preferences.providers);
  const [mood, setMood] = useState<string>(preferences.mood);
  const [importStatus, setImportStatus] = useState('');
  const [csvStatus, setCsvStatus] = useState('');
  const [serverBackups, setServerBackups] = useState<ServerBackupMetadata[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [remoteSyncInfo, setRemoteSyncInfo] = useState<any>(null);
  const [activeSyncOp, setActiveSyncOp] = useState<SyncOperationKind | null>(null);
  const [latestSyncReport, setLatestSyncReport] = useState<BidirectionalSyncReport | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionProbeResult, setConnectionProbeResult] = useState<any>(null);
  const [updatingPublicConsent, setUpdatingPublicConsent] = useState(false);
  const [exportingExcelMode, setExportingExcelMode] = useState<'xlsx_only' | 'json_and_xlsx' | null>(null);
  const [uploadExcelToGithub, setUploadExcelToGithub] = useState(false);
  const [excelExportReport, setExcelExportReport] = useState<ProfileBackupExportReportClient | null>(null);
  const [downloadingBinaryKind, setDownloadingBinaryKind] = useState<'xlsx' | 'json' | null>(null);
  const [verifiedDownloadInfo, setVerifiedDownloadInfo] = useState<{
    sizeBytes: number;
    sha256: string | null;
    fileName: string;
  } | null>(null);
  const [downloadBinaryError, setDownloadBinaryError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  const otherProfiles = useMemo(
    () => profiles.filter((p) => p.id !== activeProfileId),
    [profiles, activeProfileId]
  );

  useEffect(() => {
    if (isOpen) {
      setName(activeProfileName);
      setSelectedProviders(preferences.providers);
      setMood(preferences.mood);
      setImportStatus('');
      setCsvStatus('');
      setBackupMessage('');
      setLatestSyncReport(null);
      setConnectionProbeResult(null);
      setExcelExportReport(null);
      setVerifiedDownloadInfo(null);
      setDownloadBinaryError(null);
      void fetchSyncStatus().then((info) => {
        if (info) setRemoteSyncInfo(info);
      });
      if (otherProfiles.length > 0 && !otherProfiles.some((p) => p.id === compareProfileId)) {
        setCompareProfileId(otherProfiles[0].id);
      }
    }
  }, [isOpen, activeProfileName, activeProfileId, preferences, otherProfiles, compareProfileId]);

  const effectiveActiveProfile: Profile = useMemo(
    () => ({
      id: activeProfileId,
      name: activeProfileName,
      createdAt: activeProfile?.createdAt || '',
      preferences,
      items: savedItems,
      favoriteActors:
        favoriteActors && favoriteActors.length > 0
          ? favoriteActors
          : activeProfile?.favoriteActors || [],
      isDemo,
    }),
    [activeProfileId, activeProfileName, activeProfile, preferences, savedItems, favoriteActors, isDemo]
  );

  const tasteDna = useMemo(
    () => buildTasteDnaProfile(effectiveActiveProfile, genresMap),
    [effectiveActiveProfile, genresMap]
  );

  const journeyTimeline = useMemo(
    () => buildMediaJourneyTimeline(effectiveActiveProfile, tasteEntries, 15),
    [effectiveActiveProfile, tasteEntries]
  );

  const compareProfile = useMemo(
    () => otherProfiles.find((p) => p.id === compareProfileId) || null,
    [otherProfiles, compareProfileId]
  );

  const watchlistOverlap = useMemo(() => {
    if (!compareProfile) return null;
    return computeProfileWatchlistIntersection(effectiveActiveProfile, compareProfile);
  }, [effectiveActiveProfile, compareProfile]);

  if (!isOpen) return null;

  // --- Calculate Detailed Watch Statistics ---
  const movies = savedItems.filter((i) => i.media_type === 'movie');
  const tvShows = savedItems.filter((i) => i.media_type === 'tv');

  const completedMovies = movies.filter((m) => m.status === 'completed');
  const watchingMovies = movies.filter((m) => m.status === 'watching');
  const watchlistMovies = movies.filter((m) => m.status === 'watchlist');

  const completedTvs = tvShows.filter((t) => t.status === 'completed');
  const watchingTvs = tvShows.filter((t) => t.status === 'watching');
  const watchlistTvs = tvShows.filter((t) => t.status === 'watchlist');

  // Movie watch time calculation
  let movieMinutes = 0;
  for (const m of movies) {
    movieMinutes += calculateItemWatchMinutes(m);
  }

  // TV watch time calculation (always includes accurate duration even if episodes weren't manually logged)
  let tvMinutes = 0;
  let totalEpisodesWatched = 0;
  for (const t of tvShows) {
    tvMinutes += calculateItemWatchMinutes(t);
    totalEpisodesWatched += getTvShowEpisodesCount(t);
  }

  const overallMinutes = movieMinutes + tvMinutes;
  const movieTimeFmt = formatMinutes(movieMinutes);
  const tvTimeFmt = formatMinutes(tvMinutes);
  const overallTimeFmt = formatMinutes(overallMinutes);

  const movieTimePercent = overallMinutes > 0 ? Math.round((movieMinutes / overallMinutes) * 100) : 50;
  const tvTimePercent = overallMinutes > 0 ? 100 - movieTimePercent : 50;

  // Genre distribution calculation based on filter (all, movie, tv)
  const watchedForGenres = savedItems.filter((item) => {
    if (genreMediaTypeFilter !== 'all' && item.media_type !== genreMediaTypeFilter) return false;
    return item.status === 'completed' || item.status === 'watching' || Number(item.personal_rating) >= 1;
  });

  const genreCounts: Record<string, { name: string; count: number }> = {};
  let totalGenreHits = 0;

  for (const item of watchedForGenres) {
    for (const gid of item.genre_ids || []) {
      const gName = genresMap[gid];
      if (gName) {
        if (!genreCounts[gid]) {
          genreCounts[gid] = { name: gName, count: 0 };
        }
        genreCounts[gid].count += 1;
        totalGenreHits += 1;
      }
    }
  }

  const sortedGenres = Object.values(genreCounts).sort((a, b) => b.count - a.count);
  const topGenre = sortedGenres[0] || null;

  // Rating stats
  const ratedItems = savedItems.filter(
    (item) => Number.isFinite(Number(item.personal_rating)) && item.personal_rating !== ''
  );
  const averageRating = ratedItems.length
    ? (
        ratedItems.reduce((sum, item) => sum + Number(item.personal_rating), 0) / ratedItems.length
      ).toFixed(1)
    : null;

  // Completion Rate: (İzlenenler Listesindeki İçerikler / (İzlenecekler + İzlenenler)) * 100
  const completedCount = completedMovies.length + completedTvs.length;
  const watchlistCount = watchlistMovies.length + watchlistTvs.length;
  const targetTotal = watchlistCount + completedCount;
  const completionRate = targetTotal > 0 ? Math.round((completedCount / targetTotal) * 100) : 0;

  const handleProfileNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveProfileName(name.trim() || 'Profilim');
    onClose();
  };

  const handleProviderToggle = (id: string) => {
    setSelectedProviders((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > DEFAULT_MAX_DATA_BYTES) {
        setImportStatus(
          `Seçilen yedek dosyası izin verilen sınırı (${formatMaxDataLimitMb(DEFAULT_MAX_DATA_BYTES)}) aşıyor.`
        );
        e.target.value = '';
        return;
      }
      setImportStatus('');
      onImportBackupFile(file);
    }
    e.target.value = '';
  };

  const handleExportCsv = () => {
    const csvContent = exportItemsToCsv(savedItems);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cinetrack-${activeProfileId}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCsvStatus(`${savedItems.length} içerik CSV olarak dışa aktarıldı.`);
  };

  const triggerVerifiedBlobDownload = async (opts: {
    downloadUrl: string;
    fileName: string;
    kind: 'xlsx' | 'json';
    expectedSizeBytes?: number;
    expectedSha256?: string;
  }) => {
    setDownloadingBinaryKind(opts.kind);
    setDownloadBinaryError(null);
    try {
      const verified = await downloadVerifiedBackupBinary({
        downloadUrl: opts.downloadUrl,
        fileName: opts.fileName,
        kind: opts.kind,
        expectedSizeBytes: opts.expectedSizeBytes,
        expectedSha256: opts.expectedSha256,
        fallbackStreamPayload: {
          profileId: activeProfileId,
          profileSnapshot: effectiveActiveProfile,
          dislikedItemsHint: dislikedItems,
          genresMap,
        },
      });
      const blobUrl = URL.createObjectURL(verified.blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = verified.fileName;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

      if (opts.kind === 'xlsx') {
        setVerifiedDownloadInfo({
          sizeBytes: verified.sizeBytes,
          sha256: verified.sha256,
          fileName: verified.fileName,
        });
      }
    } catch (err: any) {
      setDownloadBinaryError(
        err?.message || 'Yedek dosyası ikili olarak doğrulanıp indirilemedi.'
      );
    } finally {
      setDownloadingBinaryKind(null);
    }
  };

  const handleExportFormattedBackup = async (mode: 'xlsx_only' | 'json_and_xlsx') => {
    if (exportingExcelMode !== null) return;
    setExportingExcelMode(mode);
    setExcelExportReport(null);
    setVerifiedDownloadInfo(null);
    setDownloadBinaryError(null);
    try {
      const report = await createProfileBackupExport({
        profileId: activeProfileId,
        profileSnapshot: effectiveActiveProfile,
        dislikedItemsHint: dislikedItems,
        genresMap,
        includeJson: mode === 'json_and_xlsx',
        includeXlsx: true,
        uploadToGithub: uploadExcelToGithub,
      });
      setExcelExportReport(report);
      if (report.excelBackup?.ok && report.excelBackup.downloadUrl) {
        await triggerVerifiedBlobDownload({
          downloadUrl: report.excelBackup.downloadUrl,
          fileName: report.excelBackup.fileName || 'CineTrack_Profile.xlsx',
          kind: 'xlsx',
          expectedSizeBytes: report.excelBackup.sizeBytes,
          expectedSha256: report.excelBackup.sha256,
        });
      }
      if (mode === 'json_and_xlsx' && report.jsonBackup?.ok && report.jsonBackup.downloadUrl) {
        await triggerVerifiedBlobDownload({
          downloadUrl: report.jsonBackup.downloadUrl,
          fileName: report.jsonBackup.fileName || 'CineTrack_Profile.json',
          kind: 'json',
          expectedSizeBytes: report.jsonBackup.sizeBytes,
          expectedSha256: report.jsonBackup.sha256,
        });
      }
    } finally {
      setExportingExcelMode(null);
    }
  };

  const handleCsvFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const result = importItemsFromCsv(text);
      if (result.importedItems.length === 0) {
        setCsvStatus('CSV dosyasında içe aktarılabilecek geçerli satır bulunamadı.');
        return;
      }
      onImportCsvItems?.(result.importedItems);
      setCsvStatus(
        `${result.importedItems.length} yapım içe aktarıldı (${result.detectedFormat.toUpperCase()} biçimi${
          result.skippedCount > 0 ? `, ${result.skippedCount} satır atlandı` : ''
        }).`
      );
    } catch {
      setCsvStatus('CSV dosyası okunamadı.');
    }
  };

  const applyCompletedSyncReport = async (report: BidirectionalSyncReport) => {
    setLatestSyncReport(report);
    if (report.updatedDataDocument) {
      onApplyRestoredDocument?.(report.updatedDataDocument);
    }
    const updatedInfo = await fetchSyncStatus();
    if (updatedInfo) {
      setRemoteSyncInfo(updatedInfo);
    }
  };

  const handleInspectGitHub = async () => {
    if (activeSyncOp !== null) return;
    setActiveSyncOp('inspect');
    try {
      const report = await inspectGitHubSync();
      await applyCompletedSyncReport(report);
    } finally {
      setActiveSyncOp(null);
    }
  };

  const handlePullFromGitHub = async (
    strategy: 'ask' | 'merge' | 'overwrite_with_remote' = 'ask'
  ) => {
    if (activeSyncOp !== null) return;
    setActiveSyncOp('pull');
    try {
      const report = await pullGitHubSync(strategy);
      await applyCompletedSyncReport(report);
    } finally {
      setActiveSyncOp(null);
    }
  };

  const handlePushToGitHub = async () => {
    if (activeSyncOp !== null) return;
    setActiveSyncOp('push');
    try {
      const report = await pushGitHubSync();
      await applyCompletedSyncReport(report);
    } finally {
      setActiveSyncOp(null);
    }
  };

  const handleReconcileWithGitHub = async () => {
    if (activeSyncOp !== null) return;
    setActiveSyncOp('reconcile');
    try {
      const report = await reconcileGitHubSync();
      await applyCompletedSyncReport(report);
    } finally {
      setActiveSyncOp(null);
    }
  };

  const handleTestConnection = async () => {
    if (activeSyncOp !== null || testingConnection) return;
    setTestingConnection(true);
    try {
      const probe = await testGitHubConnection(true);
      setConnectionProbeResult(probe);
      const updatedInfo = await fetchSyncStatus();
      if (updatedInfo) setRemoteSyncInfo(updatedInfo);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleTogglePublicConsent = async (nextAllow: boolean) => {
    if (updatingPublicConsent || activeSyncOp !== null) return;
    setUpdatingPublicConsent(true);
    try {
      const res = await setPublicRepoPersonalSyncConsent(nextAllow);
      if (res?.status) {
        setRemoteSyncInfo(res.status);
      } else {
        const updatedInfo = await fetchSyncStatus();
        if (updatedInfo) setRemoteSyncInfo(updatedInfo);
      }
    } finally {
      setUpdatingPublicConsent(false);
    }
  };

  const syncBanner = deriveSyncUiBanner(remoteSyncInfo, latestSyncReport);
  const localSide: SyncSideSummary | null =
    latestSyncReport?.localAfter || remoteSyncInfo?.localSummary || null;
  const remoteSide: SyncSideSummary | null =
    latestSyncReport?.remoteAfter ??
    latestSyncReport?.remoteBefore ??
    remoteSyncInfo?.lastRemoteSummary ??
    null;
  const activeComparison: SyncComparisonSummary | null =
    latestSyncReport?.comparison ?? remoteSyncInfo?.lastComparison ?? null;

  const pendingFilesCount =
    latestSyncReport?.filesPending.length ?? remoteSyncInfo?.fileSummaryCounts?.pending ?? 0;
  const downloadedFilesCount =
    latestSyncReport?.filesDownloaded.length ?? remoteSyncInfo?.fileSummaryCounts?.downloaded ?? 0;
  const uploadedFilesCount =
    latestSyncReport?.filesUploaded.length ?? remoteSyncInfo?.fileSummaryCounts?.uploaded ?? 0;
  const mergedFilesCount =
    latestSyncReport?.filesMerged.length ?? remoteSyncInfo?.fileSummaryCounts?.merged ?? 0;
  const skippedFilesCount =
    latestSyncReport?.filesUnchanged.length ?? remoteSyncInfo?.fileSummaryCounts?.skipped ?? 0;
  const failedFilesCount =
    latestSyncReport?.filesFailed.length ?? remoteSyncInfo?.fileSummaryCounts?.failed ?? 0;

  const lastErrorDescription: string | null =
    latestSyncReport && latestSyncReport.errors.length > 0
      ? latestSyncReport.errors.map((e) => e.message).join(' | ')
      : remoteSyncInfo?.lastError || null;

  const isPersonalSyncBlocked = Boolean(
    (latestSyncReport?.filesBlockedPublic?.length ?? 0) > 0 ||
      remoteSyncInfo?.personalSyncBlockedByPublicGuard
  );

  const isObservedOrConfiguredPublic = Boolean(
    remoteSyncInfo?.isPublicRepo ||
      remoteSyncInfo?.configDiagnostics?.observedRemoteIsPublicRepo
  );

  const isSyncActionDisabled =
    activeSyncOp !== null ||
    testingConnection ||
    Boolean(remoteSyncInfo?.syncInProgress) ||
    !remoteSyncInfo?.configured;

  const handleLoadServerBackups = async () => {
    setLoadingBackups(true);
    setBackupMessage('');
    try {
      const list = await fetchServerBackups();
      setServerBackups(list);
      if (list.length === 0) {
        setBackupMessage('Sunucuda henüz döner yedek (snapshot) kaydı bulunmuyor.');
      }
    } finally {
      setLoadingBackups(false);
    }
  };

  const handleRestoreSnapshot = async (backupId: string) => {
    setLoadingBackups(true);
    setBackupMessage('');
    try {
      const doc = await restoreServerBackup(backupId);
      if (doc) {
        onApplyRestoredDocument?.(doc);
        setBackupMessage('Seçilen sunucu yedeği başarıyla geri yüklendi.');
        const updatedList = await fetchServerBackups();
        setServerBackups(updatedList);
      } else {
        setBackupMessage('Sunucu yedeği geri yüklenemedi.');
      }
    } finally {
      setLoadingBackups(false);
    }
  };

  return (
    <div
      id="profileModal"
      className="modal-wrap open"
      aria-hidden="false"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profileModalTitle"
        aria-describedby="profileDescription"
        tabIndex={-1}
      >
        <button className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-close"></use>
          </svg>
        </button>

        <div className="profile-form">
          <div>
            <h2 id="profileModalTitle" className="detail-title" style={{ marginBottom: '5px' }}>
              {activeProfileName}
            </h2>
            <div id="profileDescription" className="detail-meta">
              Kişisel izleme istatistikleri, tür analizi ve profil ayarları.
            </div>
          </div>

          {/* Navigation Tabs between Statistics & Settings */}
          <div className="profile-nav-tabs" role="tablist">
            <button
              type="button"
              className={`profile-nav-tab ${activeTab === 'stats' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'stats'}
              onClick={() => setActiveTab('stats')}
            >
              📊 İzleme İstatistikleri
            </button>
            <button
              type="button"
              className={`profile-nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'settings'}
              onClick={() => setActiveTab('settings')}
            >
              ⚙️ Profil & Tercihler
            </button>
          </div>

          {activeTab === 'stats' && (
            <div className="profile-stats-card">
              {/* Overall Total Time Highlight Card */}
              <div className="profile-stat-box highlight">
                <div className="stat-icon-wrap">
                  <svg className="icon" aria-hidden="true">
                    <use href="#icon-clock"></use>
                  </svg>
                  <span>Genel Toplam İzleme Süresi</span>
                </div>
                <div className="stat-big-val">{overallTimeFmt.primary}</div>
                <div className="stat-sub">{overallTimeFmt.secondary}</div>

                {/* Film vs TV visual proportion bar */}
                {overallMinutes > 0 && (
                  <div style={{ marginTop: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-2)', marginBottom: '5px' }}>
                      <span>🎬 Filmler (%{movieTimePercent})</span>
                      <span>📺 Diziler (%{tvTimePercent})</span>
                    </div>
                    <div style={{ height: '7px', background: 'var(--bg-app)', borderRadius: '999px', overflow: 'hidden', display: 'flex' }}>
                      <div style={{ width: `${movieTimePercent}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-strong))' }} title={`Filmler: ${movieTimeFmt.primary}`}></div>
                      <div style={{ width: `${tvTimePercent}%`, background: 'linear-gradient(90deg, var(--danger), #fb923c)' }} title={`Diziler: ${tvTimeFmt.primary}`}></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Movie & TV Separate Time Breakdown Grid */}
              <div className="profile-stats-grid">
                {/* Film Stats Box */}
                <div className="profile-stat-box">
                  <div className="stat-icon-wrap" style={{ color: '#38bdf8' }}>
                    <svg className="icon" aria-hidden="true">
                      <use href="#icon-film"></use>
                    </svg>
                    <span>Film İzleme Süresi</span>
                  </div>
                  <div className="stat-big-val" style={{ color: '#e0f2fe' }}>{movieTimeFmt.primary}</div>
                  <div className="stat-sub">
                    <strong>{completedMovies.length} film</strong> izlendi
                    {watchingMovies.length > 0 ? ` · ${watchingMovies.length} izleniyor` : ''}
                    {watchlistMovies.length > 0 ? ` · ${watchlistMovies.length} beklemede` : ''}
                  </div>
                  <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
                    {movieTimeFmt.secondary}
                  </div>
                </div>

                {/* TV Stats Box */}
                <div className="profile-stat-box">
                  <div className="stat-icon-wrap" style={{ color: '#fb7185' }}>
                    <svg className="icon" aria-hidden="true">
                      <use href="#icon-play"></use>
                    </svg>
                    <span>Dizi İzleme Süresi</span>
                  </div>
                  <div className="stat-big-val" style={{ color: '#ffe4e6' }}>{tvTimeFmt.primary}</div>
                  <div className="stat-sub">
                    <strong>{totalEpisodesWatched} bölüm</strong> izlendi
                    {completedTvs.length > 0 ? ` · ${completedTvs.length} bitti` : ''}
                    {watchingTvs.length > 0 ? ` · ${watchingTvs.length} izleniyor` : ''}
                  </div>
                  <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
                    {tvTimeFmt.secondary}
                  </div>
                </div>
              </div>

              {/* Rating & Completion Highlights */}
              <div className="profile-stats-grid">
                <div className="profile-stat-box">
                  <div className="stat-icon-wrap" style={{ color: '#fbbf24' }}>
                    <svg className="icon" aria-hidden="true">
                      <use href="#icon-star"></use>
                    </svg>
                    <span>Kişisel Puan Ortalaması</span>
                  </div>
                  <div className="stat-big-val" style={{ color: '#fbbf24' }}>
                    {averageRating ? `${averageRating} / 10` : 'Puan Yok'}
                  </div>
                  <div className="stat-sub">
                    {ratedItems.length > 0 ? `${ratedItems.length} yapım değerlendirildi` : 'Henüz puan verilmedi'}
                  </div>
                </div>

                <div className="profile-stat-box">
                  <div className="stat-icon-wrap" style={{ color: '#34d399' }}>
                    <svg className="icon" aria-hidden="true">
                      <use href="#icon-check"></use>
                    </svg>
                    <span>İzleme Listesi Tamamlama</span>
                  </div>
                  <div className="stat-big-val" style={{ color: '#34d399' }}>
                    %{completionRate}
                  </div>
                  <div className="stat-sub">
                    {targetTotal > 0
                      ? `${completedCount} tamamlandı / ${targetTotal} hedef (İzlenecek + İzlenen)`
                      : 'Henüz izleme listesi oluşturulmadı'}
                  </div>
                  <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
                    Yalnızca İzlenecekler ve İzlenenler oranı
                  </div>
                </div>
              </div>

              {/* Genre / Category Distribution Card */}
              <div className="genre-dist-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                  <h4 style={{ margin: 0 }}>
                    <span>İzlenen Kategori Dağılımı</span>
                  </h4>
                  {topGenre && (
                    <span className="top-genre-badge">
                      🏆 En Çok İzlenen: {topGenre.name}
                    </span>
                  )}
                </div>

                {/* Sub-filter tabs for Category distribution: All, Movies only, TV only */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
                  <button
                    type="button"
                    className={`filter-chip ${genreMediaTypeFilter === 'all' ? 'active' : ''}`}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '8px',
                      fontSize: '11px',
                      fontWeight: 600,
                      border: '1px solid var(--border)',
                      background: genreMediaTypeFilter === 'all' ? '#1e293b' : '#0b1120',
                      color: genreMediaTypeFilter === 'all' ? '#fff' : '#94a3b8',
                      cursor: 'pointer'
                    }}
                    onClick={() => setGenreMediaTypeFilter('all')}
                  >
                    Tümü ({watchedItemsCount(savedItems, 'all')})
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${genreMediaTypeFilter === 'movie' ? 'active' : ''}`}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '8px',
                      fontSize: '11px',
                      fontWeight: 600,
                      border: '1px solid var(--border)',
                      background: genreMediaTypeFilter === 'movie' ? '#1e293b' : '#0b1120',
                      color: genreMediaTypeFilter === 'movie' ? '#fff' : '#94a3b8',
                      cursor: 'pointer'
                    }}
                    onClick={() => setGenreMediaTypeFilter('movie')}
                  >
                    🎬 Filmler ({watchedItemsCount(savedItems, 'movie')})
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${genreMediaTypeFilter === 'tv' ? 'active' : ''}`}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '8px',
                      fontSize: '11px',
                      fontWeight: 600,
                      border: '1px solid var(--border)',
                      background: genreMediaTypeFilter === 'tv' ? '#1e293b' : '#0b1120',
                      color: genreMediaTypeFilter === 'tv' ? '#fff' : '#94a3b8',
                      cursor: 'pointer'
                    }}
                    onClick={() => setGenreMediaTypeFilter('tv')}
                  >
                    📺 Diziler ({watchedItemsCount(savedItems, 'tv')})
                  </button>
                </div>

                {sortedGenres.length === 0 ? (
                  <p className="provider-message">
                    Henüz seçilen filtreye uygun izlenmiş veya tamamlanmış içerik bulunmuyor. İzleme listenize içerik ekledikçe kategori dağılımı otomatik olarak burada listelenecektir.
                  </p>
                ) : (
                  <div className="genre-bars">
                    {sortedGenres.slice(0, 8).map((g, index) => {
                      const percent = totalGenreHits > 0 ? Math.round((g.count / totalGenreHits) * 100) : 0;
                      // Palette variation for top bars
                      const gradient = index === 0
                        ? 'linear-gradient(90deg, var(--danger), #fb923c)'
                        : index === 1
                        ? 'linear-gradient(90deg, #38bdf8, #818cf8)'
                        : index === 2
                        ? 'linear-gradient(90deg, #10b981, #34d399)'
                        : 'linear-gradient(90deg, #64748b, #94a3b8)';

                      return (
                        <div key={g.name} className="genre-bar-item">
                          <span className="genre-bar-name" title={g.name}>
                            {index === 0 ? '👑 ' : ''}{g.name}
                          </span>
                          <div className="genre-bar-track">
                            <div className="genre-bar-fill" style={{ width: `${percent}%`, background: gradient }}></div>
                          </div>
                          <span className="genre-bar-count">
                            %{percent} <span style={{ color: '#64748b' }}>({g.count})</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Faz 10: Zevk DNA Özeti */}
              <div className="profile-tools-section">
                <h4 className="profile-tools-heading">
                  <svg className="icon" width="16" height="16" aria-hidden="true">
                    <use href="#icon-dna"></use>
                  </svg>
                  <span>Zevk DNA Özeti</span>
                </h4>
                <div className="dna-traits-grid">
                  {tasteDna.signatureTraits.map((trait) => (
                    <div key={trait.label} className="dna-trait-item">
                      <span className="dna-trait-label">{trait.label}</span>
                      <span className="dna-trait-value">{trait.value}</span>
                      <span className="dna-trait-detail">{trait.detail}</span>
                    </div>
                  ))}
                </div>
                {tasteDna.topGenres.length > 0 && (
                  <p className="dna-inline-meta">
                    <strong>Baskın Türler:</strong>{' '}
                    {tasteDna.topGenres.map((g) => `${g.name} (%${g.sharePercent})`).join(' · ')}
                  </p>
                )}
                {tasteDna.topPeople.length > 0 && (
                  <p className="dna-inline-meta">
                    <strong>Öne Çıkan İsimler:</strong>{' '}
                    {tasteDna.topPeople.map((p) => `${p.name} (${p.role})`).join(' · ')}
                  </p>
                )}
              </div>

              {/* Faz 10: Birlikte Ne İzlesek? (İki Profil Kesişimi) */}
              {otherProfiles.length > 0 && (
                <div className="profile-tools-section">
                  <h4 className="profile-tools-heading">Birlikte Ne İzlesek? (Profil Kesişimi)</h4>
                  <div className="overlap-select-row">
                    <label htmlFor="compareProfileSelect" className="provider-message">
                      Karşılaştırılacak profil:
                    </label>
                    <select
                      id="compareProfileSelect"
                      value={compareProfileId}
                      onChange={(e) => setCompareProfileId(e.target.value)}
                    >
                      {otherProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {watchlistOverlap &&
                  (watchlistOverlap.commonWatchlist.length > 0 ||
                    watchlistOverlap.recommendedByOneToOther.length > 0) ? (
                    <div className="overlap-results-list">
                      {watchlistOverlap.commonWatchlist.map((item) => (
                        <div key={`common-${item.media_type}:${item.id}`} className="overlap-row">
                          <span>{item.title || item.name}</span>
                          <span className="journey-date">Ortak İzlenecek Listesi</span>
                        </div>
                      ))}
                      {watchlistOverlap.recommendedByOneToOther.map((rec) => (
                        <div key={`rec-${rec.item.media_type}:${rec.item.id}`} className="overlap-row">
                          <span>{rec.item.title || rec.item.name}</span>
                          <span className="journey-date">
                            {rec.recommenderName} önerisi ({rec.rating}/10)
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="provider-message">
                      Seçili profil ile henüz ortak izlenecek yapım bulunmuyor.
                    </p>
                  )}
                </div>
              )}

              {/* Faz 10: İzleme Yolculuğu Zaman Çizelgesi */}
              <div className="profile-tools-section">
                <h4 className="profile-tools-heading">İzleme Yolculuğu Zaman Çizelgesi</h4>
                {journeyTimeline.length === 0 ? (
                  <p className="provider-message">
                    Kütüphaneye yapım ekledikçe ve tamamladıkça kronolojik yolculuğunuz burada listelenir.
                  </p>
                ) : (
                  <div className="journey-timeline-list">
                    {journeyTimeline.map((m) => (
                      <div key={m.id} className="journey-row">
                        <div>
                          <strong>{m.title}</strong>
                          <span className="provider-message"> · {m.detail}</span>
                        </div>
                        <span className="journey-date">{m.timestamp.slice(0, 10)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <form onSubmit={handleProfileNameSubmit} style={{ display: 'grid', gap: '14px' }}>
              <p id="syncStatus" className="provider-message" role="status" aria-live="polite">
                {syncStatus}
              </p>

              <label htmlFor="profileName">
                Profil adı
                <input
                  id="profileName"
                  className="field"
                  type="text"
                  maxLength={40}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Profil adı"
                  required
                />
              </label>

              {/* Data Mode Indicator & Toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(51, 65, 85, 0.6)', borderRadius: '12px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Veri Kaynağı:</span>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: isDemo ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                      color: isDemo ? '#fcd34d' : '#6ee7b7',
                      border: isDemo ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                    }}
                  >
                    {isDemo ? '🟡 Demo Modu (Örnek Yapımlar)' : '🟢 Canlı Veri (Kişisel Profil)'}
                  </span>
                </div>
                {onToggleDemoMode && (
                  <button
                    type="button"
                    onClick={onToggleDemoMode}
                    className="btn"
                    style={{ fontSize: '11px', padding: '4px 10px' }}
                  >
                    {isDemo ? 'Canlı Moda Geç' : 'Demo Moduna Al'}
                  </button>
                )}
              </div>

              {/* Section 6.7: Profil Kartları Izgarası */}
              <div className="profile-cards-section">
                <span className="profile-section-label">Profiller</span>
                <div className="profile-cards-grid" role="radiogroup" aria-label="Profiller">
                  {profiles.map((p) => {
                    const isActive = p.id === activeProfileId;
                    const initial = (p.name || 'P').charAt(0).toUpperCase();
                    const itemCount = p.items?.length || (p.id === activeProfileId ? savedItems.length : 0);
                    return (
                      <div
                        key={p.id}
                        role="radio"
                        aria-checked={isActive}
                        tabIndex={0}
                        className={`profile-picker-card ${isActive ? 'is-active' : ''}`}
                        onClick={() => {
                          if (p.id !== activeProfileId) {
                            onSwitchProfile(p.id);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (p.id !== activeProfileId) onSwitchProfile(p.id);
                          }
                        }}
                      >
                        <div className="profile-card-avatar" aria-hidden="true">
                          {initial}
                        </div>
                        <div className="profile-card-info">
                          <strong className="profile-card-name clamp-1">{p.name}</strong>
                          <span className="profile-card-meta tabular-nums">
                            {itemCount} içerik {p.isDemo ? '· Demo' : ''}
                          </span>
                        </div>
                        {isActive && <span className="profile-card-active-badge">Aktif</span>}
                      </div>
                    );
                  })}

                  {/* Yeni Profil Kartı (Kesikli Çerçeve) */}
                  <div className="profile-picker-card profile-card-new">
                    <div className="profile-card-avatar avatar-new" aria-hidden="true">+</div>
                    <div className="profile-card-new-form">
                      <input
                        id="newProfileName"
                        className="field new-profile-input"
                        type="text"
                        maxLength={40}
                        value={newProfileName}
                        onChange={(e) => setNewProfileName(e.target.value)}
                        placeholder="Yeni profil adı…"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (newProfileName.trim()) {
                              onCreateProfile(newProfileName.trim());
                              setNewProfileName('');
                            }
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (newProfileName.trim()) {
                            onCreateProfile(newProfileName.trim());
                            setNewProfileName('');
                          }
                        }}
                        disabled={!newProfileName.trim()}
                      >
                        Oluştur
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Streaming Providers Preferences */}
              <div className="provider-section">
                <strong>Sana Özel Öneriler İçin Yayın Platformları</strong>
                <p className="provider-message">
                  Seçtiğin platformlar &quot;Sana Özel&quot; algoritmasında önceliklendirilir.
                </p>
                <div className="provider-chips">
                  {PROVIDER_OPTIONS.map(([id, label]) => {
                    const isSelected = selectedProviders.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`chip ${isSelected ? 'active' : ''}`}
                        onClick={() => handleProviderToggle(id)}
                        aria-pressed={isSelected}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Mood Selector */}
              <label htmlFor="prefMood">
                Ruh Hâli / Öneri Modu
                <select id="prefMood" value={mood} onChange={(e) => setMood(e.target.value)}>
                  <option value="">Standart (Kişisel zevkler)</option>
                  <option value="feel-good">İyi Hissettiren (Komedi & Aile)</option>
                  <option value="dark">Karanlık & Gerilimli (Gizem & Suç)</option>
                  <option value="adrenaline">Adrenalin (Aksiyon & Macera)</option>
                  <option value="mind-bending">Kafa Yoran (Bilim Kurgu & Gizem)</option>
                </select>
              </label>

              <button
                type="button"
                className="btn"
                style={{ justifySelf: 'start' }}
                onClick={() => onSavePreferences(selectedProviders, mood)}
              >
                Tercihleri kaydet
              </button>

              {/* Release Reminders */}
              <div className="preference-settings">
                <strong>Yayın Hatırlatıcıları</strong>
                <p className="provider-message">
                  Listendeki yapımların vizyona giriş ve yeni bölüm tarihlerinde tarayıcı bildirimi al.
                </p>
                <button
                  type="button"
                  className={`btn ${preferences.reminders ? 'btn-primary' : ''}`}
                  onClick={onToggleReminders}
                >
                  {preferences.reminders ? '✓ Hatırlatıcılar Açık' : 'Hatırlatıcıları Aç'}
                </button>
              </div>

              {/* Backup Export / Import */}
              <div className="profile-backup">
                <button type="button" className="btn whitespace-nowrap shrink-0" onClick={onExportBackup}>
                  JSON Yedeği İndir
                </button>
                <button
                  type="button"
                  className="btn whitespace-nowrap shrink-0"
                  onClick={() => fileInputRef.current?.click()}
                >
                  JSON Yedeği Yükle
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="file-input-hidden"
                  onChange={handleFileChange}
                />
              </div>
              {importStatus && <p className="provider-message">{importStatus}</p>}

              {/* Posterli, 5 Sekmeli Excel (.xlsx) Profil Yedeği */}
              <div className="profile-tools-section excel-backup-section">
                <strong className="profile-tools-heading">Excel Profil Yedeği (.xlsx)</strong>
                <p className="provider-message">
                  Kişisel film ve dizi arşivinizi gömülü posterlerle birlikte 5 sekmeli (Özet, İzlenen,
                  İzlenecek, İzleniyor, İlgilenmiyorum), filtrelenebilir ve çevrimdışı açılabilir Excel
                  çalışma kitabına aktarır. JSON yedeği birincil geri yükleme biçimi olarak korunur.
                </p>

                <div className="csv-actions-row mt-2.5">
                  <button
                    type="button"
                    className="btn btn-primary whitespace-nowrap shrink-0"
                    disabled={exportingExcelMode !== null}
                    onClick={() => handleExportFormattedBackup('xlsx_only')}
                  >
                    {exportingExcelMode === 'xlsx_only'
                      ? 'Posterler gömülüyor ve Excel hazırlanıyor…'
                      : 'Excel Profil Yedeği (.xlsx)'}
                  </button>
                  <button
                    type="button"
                    className="btn whitespace-nowrap shrink-0"
                    disabled={exportingExcelMode !== null}
                    onClick={() => handleExportFormattedBackup('json_and_xlsx')}
                  >
                    {exportingExcelMode === 'json_and_xlsx'
                      ? 'JSON + Excel yedekleniyor…'
                      : 'JSON + Excel Birlikte Yedekle'}
                  </button>
                </div>

                {remoteSyncInfo?.remoteTarget && (
                  <label className="excel-github-toggle">
                    <input
                      type="checkbox"
                      checked={uploadExcelToGithub}
                      disabled={exportingExcelMode !== null}
                      onChange={(e) => setUploadExcelToGithub(e.target.checked)}
                    />
                    <span>
                      Oluşturulan <code>.xlsx</code> arşivini GitHub deposuna (
                      <code>data/exports/</code>) da yükle ve SHA-256 geri okumasını doğrula
                    </span>
                  </label>
                )}

                {exportingExcelMode !== null && (
                  <div className="excel-backup-progress" role="status" aria-live="polite">
                    Poster önbelleği taranıyor ve Excel çalışma kitabı oluşturuluyor ({savedItems.length + preferences.disliked.length} kayıt)…
                  </div>
                )}

                {excelExportReport && (
                  <div className="excel-backup-report tabular-nums" role="status" aria-live="polite">
                    <div className="excel-backup-metrics-grid">
                      <div className="excel-metric-cell">
                        <span className="excel-metric-label">JSON Yedeği</span>
                        <strong className="excel-metric-val">
                          {!excelExportReport.jsonBackup.attempted
                            ? 'İstenmedi (Korundu)'
                            : excelExportReport.jsonBackup.ok
                              ? 'Başarılı'
                              : 'Başarısız'}
                        </strong>
                        {excelExportReport.jsonBackup.relativePath && (
                          <span className="excel-metric-sub">{excelExportReport.jsonBackup.relativePath}</span>
                        )}
                      </div>

                      <div className="excel-metric-cell">
                        <span className="excel-metric-label">Excel Yedeği (.xlsx)</span>
                        <strong className="excel-metric-val">
                          {excelExportReport.excelBackup.ok ? 'Başarılı' : 'Başarısız'}
                        </strong>
                        {excelExportReport.excelBackup.relativePath && (
                          <span className="excel-metric-sub">{excelExportReport.excelBackup.relativePath}</span>
                        )}
                      </div>

                      <div className="excel-metric-cell">
                        <span className="excel-metric-label">Toplam İçerik</span>
                        <strong className="excel-metric-val">
                          {excelExportReport.excelBackup.totalItemsCount ?? 0} kayıt
                        </strong>
                        {excelExportReport.excelBackup.sheetCounts && (
                          <span className="excel-metric-sub">
                            İzlenen {excelExportReport.excelBackup.sheetCounts.İzlenen.total} · İzlenecek{' '}
                            {excelExportReport.excelBackup.sheetCounts.İzlenecek.total} · İzleniyor{' '}
                            {excelExportReport.excelBackup.sheetCounts.İzleniyor.total} · İlgilenmiyorum{' '}
                            {excelExportReport.excelBackup.sheetCounts.İlgilenmiyorum.total}
                          </span>
                        )}
                      </div>

                      <div className="excel-metric-cell">
                        <span className="excel-metric-label">Gömülü Poster / Hata</span>
                        <strong className="excel-metric-val">
                          {excelExportReport.excelBackup.embeddedPostersCount ?? 0} poster ·{' '}
                          {excelExportReport.excelBackup.posterErrorsCount ?? 0} hata
                        </strong>
                        {typeof excelExportReport.excelBackup.sizeBytes === 'number' && (
                          <span className="excel-metric-sub">
                            Boyut: {(excelExportReport.excelBackup.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                          </span>
                        )}
                      </div>
                    </div>

                    {excelExportReport.githubUpload.attempted && (
                      <div className="excel-github-outcome">
                        <strong>GitHub Yükleme Durumu:</strong>{' '}
                        {excelExportReport.githubUpload.ok && excelExportReport.githubUpload.verifiedReadBack
                          ? `Başarılı ve SHA-256 doğrulandı (${excelExportReport.githubUpload.repoPath})`
                          : excelExportReport.githubUpload.error || 'Yükleme doğrulanamadı.'}
                      </div>
                    )}

                    {verifiedDownloadInfo && (
                      <div className="excel-github-outcome">
                        <strong>İndirilen İkili Dosya Doğrulaması:</strong>{' '}
                        {(verifiedDownloadInfo.sizeBytes / (1024 * 1024)).toFixed(2)} MB (
                        {verifiedDownloadInfo.sizeBytes.toLocaleString('tr-TR')} bayt)
                        {verifiedDownloadInfo.sha256
                          ? ` · SHA-256 eşleşti (${verifiedDownloadInfo.sha256.slice(0, 12)}…)`
                          : ''}
                      </div>
                    )}

                    {(excelExportReport.jsonBackup.error ||
                      excelExportReport.excelBackup.error ||
                      downloadBinaryError) && (
                      <div className="excel-backup-error">
                        {downloadBinaryError ||
                          excelExportReport.excelBackup.error ||
                          excelExportReport.jsonBackup.error}
                      </div>
                    )}

                    <div className="csv-actions-row mt-2">
                      {excelExportReport.excelBackup.ok && excelExportReport.excelBackup.downloadUrl && (
                        <button
                          type="button"
                          disabled={downloadingBinaryKind !== null}
                          onClick={() =>
                            void triggerVerifiedBlobDownload({
                              downloadUrl: excelExportReport.excelBackup.downloadUrl!,
                              fileName:
                                excelExportReport.excelBackup.fileName || 'CineTrack_Profile.xlsx',
                              kind: 'xlsx',
                              expectedSizeBytes: excelExportReport.excelBackup.sizeBytes,
                              expectedSha256: excelExportReport.excelBackup.sha256,
                            })
                          }
                          className="btn btn-sm whitespace-nowrap shrink-0"
                        >
                          {downloadingBinaryKind === 'xlsx'
                            ? 'İkili dosya doğrulanıyor…'
                            : 'Excel (.xlsx) Dosyasını İndir'}
                        </button>
                      )}
                      {excelExportReport.jsonBackup.ok && excelExportReport.jsonBackup.downloadUrl && (
                        <button
                          type="button"
                          disabled={downloadingBinaryKind !== null}
                          onClick={() =>
                            void triggerVerifiedBlobDownload({
                              downloadUrl: excelExportReport.jsonBackup.downloadUrl!,
                              fileName:
                                excelExportReport.jsonBackup.fileName || 'CineTrack_Profile.json',
                              kind: 'json',
                              expectedSizeBytes: excelExportReport.jsonBackup.sizeBytes,
                              expectedSha256: excelExportReport.jsonBackup.sha256,
                            })
                          }
                          className="btn btn-sm whitespace-nowrap shrink-0"
                        >
                          {downloadingBinaryKind === 'json'
                            ? 'JSON doğrulanıyor…'
                            : 'JSON Dosyasını İndir'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Faz 10: CSV Export / Import (Letterboxd & IMDb) */}
              <div className="profile-tools-section">
                <strong className="profile-tools-heading">CSV İçe / Dışa Aktar (Letterboxd & IMDb)</strong>
                <div className="csv-actions-row">
                  <button type="button" className="btn" onClick={handleExportCsv}>
                    CSV Olarak İndir
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => csvInputRef.current?.click()}
                  >
                    CSV İçe Aktar
                  </button>
                  <input
                    ref={csvInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="file-input-hidden"
                    onChange={handleCsvFileChange}
                  />
                </div>
                {csvStatus && <p className="provider-message">{csvStatus}</p>}
              </div>

              {/* Faz 4: Server Rotating Snapshots & Restore */}
              <div className="profile-tools-section">
                <strong className="profile-tools-heading">Sunucu Yedekleri ve Geri Yükleme</strong>
                <div className="csv-actions-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={loadingBackups}
                    onClick={handleLoadServerBackups}
                  >
                    {loadingBackups ? 'Yedekler okunuyor…' : 'Sunucu Yedeklerini Listele'}
                  </button>
                </div>
                {backupMessage && <p className="provider-message">{backupMessage}</p>}
                {serverBackups.length > 0 && (
                  <div className="backups-list">
                    {serverBackups.map((b) => (
                      <div key={b.id} className="backup-row">
                        <div>
                          <div className="backup-meta">
                            {b.createdAt.slice(0, 19).replace('T', ' ')} · rev-{b.revision} · {b.itemsCount} içerik
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={loadingBackups}
                          onClick={() => handleRestoreSnapshot(b.id)}
                        >
                          Bu Yedeğe Dön
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* GitHub Çift Yönlü Senkronizasyon ve Doğrulama Paneli */}
              <div className="profile-tools-section github-sync-panel">
                <div className="github-sync-header">
                  <strong className="profile-tools-heading">GitHub Çift Yönlü Senkronizasyon</strong>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={isSyncActionDisabled}
                      onClick={handleTestConnection}
                    >
                      {testingConnection ? 'Yazma testi yapılıyor…' : 'Bağlantıyı test et'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={isSyncActionDisabled}
                      onClick={handleInspectGitHub}
                    >
                      {activeSyncOp === 'inspect' ? 'Durum denetleniyor…' : 'Durumu denetle'}
                    </button>
                  </div>
                </div>

                {/* Bağlı hedef depo ve son başarılı senkronizasyon metaverisi */}
                <div className="github-sync-target-meta tabular-nums">
                  {remoteSyncInfo?.remoteTarget ? (
                    <>
                      <span>
                        Hedef: <strong>{remoteSyncInfo.remoteTarget.owner}/{remoteSyncInfo.remoteTarget.repo}</strong>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Dal: {remoteSyncInfo.remoteTarget.branch}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {isObservedOrConfiguredPublic
                          ? remoteSyncInfo?.allowPublicPersonalSync
                            ? 'Açık Depo (Kişisel Veri Onaylı)'
                            : 'Açık Depo (Kişisel Veri Korumalı)'
                          : 'Özel Depo'}
                      </span>
                    </>
                  ) : (
                    <span>Hedef GitHub deposu tanımlanmadı</span>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>
                    Son başarılı senkronizasyon:{' '}
                    {remoteSyncInfo?.lastSyncAt
                      ? formatSyncTimestamp(remoteSyncInfo.lastSyncAt)
                      : 'Henüz yok'}
                  </span>
                </div>

                {/* Doğrulama ve durum bildirimi (verifiedEqual olmadan asla eşitlendi demez) */}
                <div
                  className={`github-sync-banner tone-${syncBanner.tone}`}
                  role="status"
                  aria-live="polite"
                >
                  <div className="github-sync-banner-title">{syncBanner.headline}</div>
                  <p className="github-sync-banner-detail">{syncBanner.detail}</p>
                </div>

                {remoteSyncInfo?.repoVisibilityWarning && (
                  <p className="github-sync-warning">{remoteSyncInfo.repoVisibilityWarning}</p>
                )}

                {isObservedOrConfiguredPublic && (
                  <div className="my-2 rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={Boolean(remoteSyncInfo?.allowPublicPersonalSync)}
                        disabled={updatingPublicConsent || activeSyncOp !== null}
                        onChange={(e) => handleTogglePublicConsent(e.target.checked)}
                      />
                      <span>
                        <strong>Açık depoya profil ve izleme listesi senkronizasyonuna izin ver:</strong>{' '}
                        Bu depo herkese açık (public) olduğu için onay verildiğinde profil ve izleme listesi
                        kayıtları GitHub üzerinde görüntülenebilir. Onay kapalıyken gizlilik koruması yalnızca
                        genel katalog dosyalarına izin verir.
                      </span>
                    </label>
                  </div>
                )}

                {connectionProbeResult && (
                  <div
                    className={`my-2 rounded border p-2.5 text-xs tabular-nums ${
                      connectionProbeResult.ok
                        ? 'border-emerald-500/30 bg-emerald-500/10'
                        : 'border-rose-500/30 bg-rose-500/10'
                    }`}
                    role="status"
                  >
                    <div>
                      <strong>Küçük Dosya Yazma ve Geri Okuma Testi ({connectionProbeResult.probeRepoPath || 'data/catalog/manifest.json'}):</strong>{' '}
                      {connectionProbeResult.ok ? 'Başarılı' : 'Başarısız'}
                    </div>
                    {connectionProbeResult.localHash && (
                      <div>
                        Yerel SHA-256: <code>{String(connectionProbeResult.localHash).slice(0, 16)}…</code>
                        {' · '}
                        Geri Okuma SHA-256:{' '}
                        <code>
                          {connectionProbeResult.readBackHash
                            ? `${String(connectionProbeResult.readBackHash).slice(0, 16)}…`
                            : 'yok'}
                        </code>
                      </div>
                    )}
                    {connectionProbeResult.error && (
                      <div className="mt-1">{connectionProbeResult.error}</div>
                    )}
                  </div>
                )}

                {/* Pull sırasında yerel veri ezilmesini önleyen onay kutusu */}
                {latestSyncReport?.requiresConfirmation && latestSyncReport.conflictSummary && (
                  <div className="github-sync-confirm-box" role="alert">
                    <div className="github-sync-confirm-title">
                      Yerel kullanıcı verisinde farklı kayıtlar algılandı
                    </div>
                    <p className="github-sync-confirm-desc tabular-nums">
                      Yerelde {latestSyncReport.conflictSummary.localItemsCount} benzersiz yapım (
                      {latestSyncReport.conflictSummary.localOnlyItemsCount} tanesi GitHub&apos;da yok),
                      GitHub&apos;da {latestSyncReport.conflictSummary.remoteItemsCount} benzersiz yapım bulunuyor.
                    </p>
                    <div className="github-sync-confirm-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={activeSyncOp !== null}
                        onClick={() => handlePullFromGitHub('merge')}
                      >
                        Kayıpsız Birleştirerek İndir
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={activeSyncOp !== null}
                        onClick={() => handlePullFromGitHub('overwrite_with_remote')}
                      >
                        Yedek Al ve GitHub Sürümünü Uygula
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={activeSyncOp !== null}
                        onClick={() => setLatestSyncReport(null)}
                      >
                        Vazgeç
                      </button>
                    </div>
                  </div>
                )}

                {/* Üç ayrı senkronizasyon eylemi */}
                <div className="github-sync-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={isSyncActionDisabled}
                    onClick={() => handlePullFromGitHub('ask')}
                  >
                    {activeSyncOp === 'pull' ? "GitHub'dan indiriliyor…" : "GitHub'dan indir"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={isSyncActionDisabled}
                    onClick={handlePushToGitHub}
                  >
                    {activeSyncOp === 'push' ? "GitHub'a yükleniyor…" : "GitHub'a yükle"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isSyncActionDisabled}
                    onClick={handleReconcileWithGitHub}
                  >
                    {activeSyncOp === 'reconcile' ? 'İki yönlü eşitleniyor…' : 'İki yönlü eşitle'}
                  </button>
                </div>

                {/* Yerel vs GitHub metrik karşılaştırma tablosu */}
                <div className="github-sync-metrics tabular-nums" aria-label="Yerel ve GitHub veri karşılaştırması">
                  <div className="github-sync-metrics-head">
                    <span>Veri Katmanı ve Ölçüt</span>
                    <span>Yerel Depo</span>
                    <span>GitHub ({remoteSyncInfo?.remoteTarget?.branch || 'main'})</span>
                  </div>

                  <div className="github-sync-metrics-row">
                    <span>Film kataloğu (benzersiz film kaydı)</span>
                    <strong>{localSide?.catalogMovieCount ?? remoteSyncInfo?.catalogCounts?.movies ?? 0} film</strong>
                    <strong>
                      {remoteSide ? `${remoteSide.catalogMovieCount} film` : 'Denetlenmedi'}
                    </strong>
                  </div>

                  <div className="github-sync-metrics-row">
                    <span>Dizi kataloğu (benzersiz dizi kaydı)</span>
                    <strong>{localSide?.catalogTvCount ?? remoteSyncInfo?.catalogCounts?.tv ?? 0} dizi</strong>
                    <strong>
                      {remoteSide ? `${remoteSide.catalogTvCount} dizi` : 'Denetlenmedi'}
                    </strong>
                  </div>

                  <div className="github-sync-metrics-row">
                    <span>Kullanıcı verisi (profil / benzersiz kayıt)</span>
                    <strong>
                      {localSide
                        ? `${localSide.userProfilesCount} profil / ${localSide.userUniqueSavedItemsCount} kayıt`
                        : `${profiles.length} profil / ${savedItems.length} kayıt`}
                    </strong>
                    <strong>
                      {remoteSide
                        ? isPersonalSyncBlocked
                          ? 'Açık depo koruması'
                          : `${remoteSide.userProfilesCount} profil / ${remoteSide.userUniqueSavedItemsCount} kayıt`
                        : 'Denetlenmedi'}
                    </strong>
                  </div>

                  <div className="github-sync-metrics-row">
                    <span>İşlenmiş profil (dosya sayısı / toplam kayıt)</span>
                    <strong>
                      {localSide
                        ? `${localSide.derivedProfileFilesCount} dosya / ${localSide.derivedProfileTotalRecordsCount} kayıt`
                        : `${remoteSyncInfo?.profilesCount ?? 0} dosya`}
                    </strong>
                    <strong>
                      {remoteSide
                        ? isPersonalSyncBlocked
                          ? 'Açık depo koruması'
                          : `${remoteSide.derivedProfileFilesCount} dosya / ${remoteSide.derivedProfileTotalRecordsCount} kayıt`
                        : 'Denetlenmedi'}
                    </strong>
                  </div>

                  <div className="github-sync-metrics-row">
                    <span>İçerik ve dosya özeti (hash) eşitliği</span>
                    <span>
                      Semantik:{' '}
                      <strong>
                        {activeComparison
                          ? activeComparison.semanticEqual
                            ? 'Eşit'
                            : 'Farklı'
                          : 'Belirsiz'}
                      </strong>
                    </span>
                    <span>
                      Ham dosya:{' '}
                      <strong>
                        {activeComparison
                          ? activeComparison.rawFilesEqual
                            ? 'Birebir eşit'
                            : activeComparison.semanticEqual
                            ? 'Zaman alanı farkı'
                            : 'Farklı'
                          : 'Belirsiz'}
                      </strong>
                    </span>
                  </div>
                </div>

                {/* Dosya işlem sayaçları (etiketli metin ayracı) */}
                <div className="github-sync-file-counters tabular-nums">
                  <span>Bekleyen dosya: <strong>{pendingFilesCount}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>İndirilen: <strong>{downloadedFilesCount}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>Yüklenen: <strong>{uploadedFilesCount}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>Birleştirilen: <strong>{mergedFilesCount}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>Atlanan (değişmeyen): <strong>{skippedFilesCount}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>Hata alan: <strong>{failedFilesCount}</strong></span>
                </div>

                {/* Farklı dosyaların nedenleri */}
                {activeComparison && activeComparison.differingFiles.length > 0 && (
                  <div className="github-sync-diff-list">
                    <div className="github-sync-subhead">
                      Farklılık tespit edilen dosyalar ({activeComparison.differingFiles.length} dosya ·{' '}
                      {activeComparison.differentRecordsCount} kayıt farkı):
                    </div>
                    {activeComparison.differingFiles.map((diff) => (
                      <div key={diff.repoPath} className="github-sync-diff-item tabular-nums">
                        <span className="github-sync-path">{diff.repoPath}</span>
                        <span className="github-sync-reason">{diff.reason}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Son hata açıklaması */}
                {lastErrorDescription && (
                  <div className="github-sync-error-detail" role="alert">
                    <strong>Son hata açıklaması:</strong> {lastErrorDescription}
                  </div>
                )}
              </div>

              <button type="submit" className="btn btn-primary">
                Profil Adını Kaydet ve Kapat
              </button>
            </form>
          )}
        </div>
      </article>
    </div>
  );
};

function watchedItemsCount(items: SavedItem[], type: 'all' | 'movie' | 'tv'): number {
  return items.filter((item) => {
    if (type !== 'all' && item.media_type !== type) return false;
    return item.status === 'completed' || item.status === 'watching' || Number(item.personal_rating) >= 1;
  }).length;
}

function formatSyncTimestamp(iso: string): string {
  const cleaned = String(iso || '').trim();
  if (!cleaned) return 'Henüz yok';
  return cleaned.slice(0, 19).replace('T', ' ');
}
