import React, { useState } from 'react';
import type { DataDocument, Profile, SavedItem } from '../core/cinetrack-core.ts';
import {
  fetchSyncStatus,
  inspectGitHubSync,
  pullGitHubSync,
  pushGitHubSync,
  reconcileGitHubSync,
  setPublicRepoPersonalSyncConsent,
  testGitHubConnection,
} from '../services/api.ts';
import {
  deriveSyncUiBanner,
  type BidirectionalSyncReport,
  type SyncComparisonSummary,
  type SyncOperationKind,
  type SyncSideSummary,
} from '../core/sync-display.ts';

export interface RemoteSyncStatusPayload {
  configured?: boolean;
  syncInProgress?: boolean;
  isPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  personalSyncBlockedByPublicGuard?: boolean;
  repoVisibilityWarning?: string;
  lastSyncAt?: string;
  lastError?: string;
  profilesCount?: number;
  catalogCounts?: { movies?: number; tv?: number };
  remoteTarget?: { owner: string; repo: string; branch: string } | null;
  configDiagnostics?: { observedRemoteIsPublicRepo?: boolean };
  localSummary?: SyncSideSummary | null;
  lastRemoteSummary?: SyncSideSummary | null;
  lastComparison?: SyncComparisonSummary | null;
  fileSummaryCounts?: {
    pending?: number;
    downloaded?: number;
    uploaded?: number;
    merged?: number;
    skipped?: number;
    failed?: number;
  };
}

interface ConnectionProbeOutcome {
  ok?: boolean;
  probeRepoPath?: string;
  localHash?: string;
  readBackHash?: string;
  error?: string;
}

interface ProfileGitHubSyncSectionProps {
  remoteSyncInfo: RemoteSyncStatusPayload | null;
  onRemoteSyncInfoChange: (next: RemoteSyncStatusPayload | null) => void;
  profiles: Profile[];
  savedItems: SavedItem[];
  onApplyRestoredDocument?: (doc: DataDocument) => void;
}

function formatSyncTimestamp(iso: string): string {
  const cleaned = String(iso || '').trim();
  if (!cleaned) return 'Henüz yok';
  return cleaned.slice(0, 19).replace('T', ' ');
}

export const ProfileGitHubSyncSection: React.FC<ProfileGitHubSyncSectionProps> = ({
  remoteSyncInfo,
  onRemoteSyncInfoChange,
  profiles,
  savedItems,
  onApplyRestoredDocument,
}) => {
  const [activeSyncOp, setActiveSyncOp] = useState<SyncOperationKind | null>(null);
  const [latestSyncReport, setLatestSyncReport] = useState<BidirectionalSyncReport | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionProbeResult, setConnectionProbeResult] =
    useState<ConnectionProbeOutcome | null>(null);
  const [updatingPublicConsent, setUpdatingPublicConsent] = useState(false);

  const applyCompletedSyncReport = async (report: BidirectionalSyncReport) => {
    setLatestSyncReport(report);
    if (report.updatedDataDocument) {
      onApplyRestoredDocument?.(report.updatedDataDocument);
    }
    const updatedInfo = (await fetchSyncStatus()) as RemoteSyncStatusPayload | null;
    if (updatedInfo) {
      onRemoteSyncInfoChange(updatedInfo);
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
      const probe = (await testGitHubConnection(true)) as ConnectionProbeOutcome | null;
      setConnectionProbeResult(probe);
      const updatedInfo = (await fetchSyncStatus()) as RemoteSyncStatusPayload | null;
      if (updatedInfo) onRemoteSyncInfoChange(updatedInfo);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleTogglePublicConsent = async (nextAllow: boolean) => {
    if (updatingPublicConsent || activeSyncOp !== null) return;
    setUpdatingPublicConsent(true);
    try {
      const res = (await setPublicRepoPersonalSyncConsent(nextAllow)) as {
        status?: RemoteSyncStatusPayload;
      } | null;
      if (res?.status) {
        onRemoteSyncInfoChange(res.status);
      } else {
        const updatedInfo = (await fetchSyncStatus()) as RemoteSyncStatusPayload | null;
        if (updatedInfo) onRemoteSyncInfoChange(updatedInfo);
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
    remoteSyncInfo?.isPublicRepo || remoteSyncInfo?.configDiagnostics?.observedRemoteIsPublicRepo
  );

  const isSyncActionDisabled =
    activeSyncOp !== null ||
    testingConnection ||
    Boolean(remoteSyncInfo?.syncInProgress) ||
    !remoteSyncInfo?.configured;

  return (
    <div className="profile-tools-section github-sync-panel">
      <div className="github-sync-header">
        <strong className="profile-tools-heading">GitHub Çift Yönlü Senkronizasyon</strong>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-sm whitespace-nowrap"
            disabled={isSyncActionDisabled}
            onClick={() => void handleTestConnection()}
          >
            {testingConnection ? 'Yazma testi yapılıyor…' : 'Bağlantıyı test et'}
          </button>
          <button
            type="button"
            className="btn btn-sm whitespace-nowrap"
            disabled={isSyncActionDisabled}
            onClick={() => void handleInspectGitHub()}
          >
            {activeSyncOp === 'inspect' ? 'Durum denetleniyor…' : 'Durumu denetle'}
          </button>
        </div>
      </div>

      <div className="github-sync-target-meta tabular-nums">
        {remoteSyncInfo?.remoteTarget ? (
          <>
            <span>
              Hedef:{' '}
              <strong>
                {remoteSyncInfo.remoteTarget.owner}/{remoteSyncInfo.remoteTarget.repo}
              </strong>
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
          {remoteSyncInfo?.lastSyncAt ? formatSyncTimestamp(remoteSyncInfo.lastSyncAt) : 'Henüz yok'}
        </span>
      </div>

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
              onChange={(e) => void handleTogglePublicConsent(e.target.checked)}
            />
            <span>
              <strong>Açık depoya profil ve izleme listesi senkronizasyonuna izin ver:</strong>{' '}
              Bu depo herkese açık (public) olduğu için onay verildiğinde profil ve izleme listesi
              kayıtları GitHub üzerinde görüntülenebilir.
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
            <strong>
              Küçük Dosya Yazma ve Geri Okuma Testi (
              {connectionProbeResult.probeRepoPath || 'data/catalog/manifest.json'}):
            </strong>{' '}
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

      {latestSyncReport?.requiresConfirmation && latestSyncReport.conflictSummary && (
        <div className="github-sync-confirm-box" role="alert">
          <div className="github-sync-confirm-title">
            Yerel kullanıcı verisinde farklı kayıtlar algılandı
          </div>
          <p className="github-sync-confirm-desc tabular-nums">
            Yerelde {latestSyncReport.conflictSummary.localItemsCount} benzersiz yapım (
            {latestSyncReport.conflictSummary.localOnlyItemsCount} tanesi GitHub&apos;da yok),
            GitHub&apos;da {latestSyncReport.conflictSummary.remoteItemsCount} benzersiz yapım
            bulunuyor.
          </p>
          <div className="github-sync-confirm-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm whitespace-nowrap"
              disabled={activeSyncOp !== null}
              onClick={() => void handlePullFromGitHub('merge')}
            >
              Kayıpsız Birleştirerek İndir
            </button>
            <button
              type="button"
              className="btn btn-sm whitespace-nowrap"
              disabled={activeSyncOp !== null}
              onClick={() => void handlePullFromGitHub('overwrite_with_remote')}
            >
              Yedek Al ve GitHub Sürümünü Uygula
            </button>
            <button
              type="button"
              className="btn btn-sm whitespace-nowrap"
              disabled={activeSyncOp !== null}
              onClick={() => setLatestSyncReport(null)}
            >
              Vazgeç
            </button>
          </div>
        </div>
      )}

      <div className="github-sync-actions">
        <button
          type="button"
          className="btn whitespace-nowrap"
          disabled={isSyncActionDisabled}
          onClick={() => void handlePullFromGitHub('ask')}
        >
          {activeSyncOp === 'pull' ? "GitHub'dan indiriliyor…" : "GitHub'dan indir"}
        </button>
        <button
          type="button"
          className="btn whitespace-nowrap"
          disabled={isSyncActionDisabled}
          onClick={() => void handlePushToGitHub()}
        >
          {activeSyncOp === 'push' ? "GitHub'a yükleniyor…" : "GitHub'a yükle"}
        </button>
        <button
          type="button"
          className="btn btn-primary whitespace-nowrap"
          disabled={isSyncActionDisabled}
          onClick={() => void handleReconcileWithGitHub()}
        >
          {activeSyncOp === 'reconcile' ? 'İki yönlü eşitleniyor…' : 'İki yönlü eşitle'}
        </button>
      </div>

      <div
        className="github-sync-metrics tabular-nums"
        aria-label="Yerel ve GitHub veri karşılaştırması"
      >
        <div className="github-sync-metrics-head">
          <span>Veri Katmanı ve Ölçüt</span>
          <span>Yerel Depo</span>
          <span>GitHub ({remoteSyncInfo?.remoteTarget?.branch || 'main'})</span>
        </div>

        <div className="github-sync-metrics-row">
          <span>Film kataloğu (benzersiz film kaydı)</span>
          <strong>{localSide?.catalogMovieCount ?? remoteSyncInfo?.catalogCounts?.movies ?? 0} film</strong>
          <strong>{remoteSide ? `${remoteSide.catalogMovieCount} film` : 'Denetlenmedi'}</strong>
        </div>

        <div className="github-sync-metrics-row">
          <span>Dizi kataloğu (benzersiz dizi kaydı)</span>
          <strong>{localSide?.catalogTvCount ?? remoteSyncInfo?.catalogCounts?.tv ?? 0} dizi</strong>
          <strong>{remoteSide ? `${remoteSide.catalogTvCount} dizi` : 'Denetlenmedi'}</strong>
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
              {activeComparison ? (activeComparison.semanticEqual ? 'Eşit' : 'Farklı') : 'Belirsiz'}
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

      <div className="github-sync-file-counters tabular-nums">
        <span>
          Bekleyen dosya: <strong>{pendingFilesCount}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          İndirilen: <strong>{downloadedFilesCount}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Yüklenen: <strong>{uploadedFilesCount}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Birleştirilen: <strong>{mergedFilesCount}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Atlanan (değişmeyen): <strong>{skippedFilesCount}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Hata alan: <strong>{failedFilesCount}</strong>
        </span>
      </div>

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

      {lastErrorDescription && (
        <div className="github-sync-error-detail" role="alert">
          <strong>Son hata açıklaması:</strong> {lastErrorDescription}
        </div>
      )}
    </div>
  );
};
