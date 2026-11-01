import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  DataDocument,
  FavoriteActorInfo,
  Profile,
  Preferences,
  SavedItem,
} from '../core/cinetrack-core';
import {
  exportItemsToCsv,
  importItemsFromCsv,
} from '../core/exporters';
import {
  createProfileBackupExport,
  downloadVerifiedBackupBinary,
  fetchServerBackups,
  fetchSyncStatus,
  restoreServerBackup,
  triggerImmediateServerBackup,
  type ProfileBackupExportReportClient,
  type ServerBackupMetadata,
} from '../services/api';
import { recordManualBackupSuccess } from '../services/auto-backup-service';
import { resetDerivedCachesPreserveProfileAndStock } from '../services/idb-schema-version';
import { PROVIDER_OPTIONS } from '../utils/helpers';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb } from '../core/limits';
import { ProfileStatsTab } from './ProfileStatsTab';
import {
  ProfileGitHubSyncSection,
  type RemoteSyncStatusPayload,
} from './ProfileGitHubSyncSection';
import { DuplicateMergePanel } from './DuplicateMergePanel';

interface ProfileModalProps {
  isOpen: boolean;
  profiles: Profile[];
  activeProfile?: Profile;
  activeProfileId: string;
  activeProfileName: string;
  preferences: Preferences;
  savedItems: SavedItem[];
  favoriteActors?: FavoriteActorInfo[];
  dislikedItems?: Array<Record<string, unknown>>;
  genresMap: Record<number, string>;
  tasteEntries?: Record<string, unknown>;
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
  onMergeDuplicates?: (
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ) => void;
  isDemo?: boolean;
  onToggleDemoMode?: () => void;
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
  onMergeDuplicates,
  isDemo = false,
  onToggleDemoMode,
}) => {
  const [activeTab, setActiveTab] = useState<'stats' | 'settings'>('stats');
  const [name, setName] = useState(activeProfileName);
  const [newProfileName, setNewProfileName] = useState('');
  const [selectedProviders, setSelectedProviders] = useState<string[]>(preferences.providers);
  const [mood, setMood] = useState<string>(preferences.mood);
  const [importStatus, setImportStatus] = useState('');
  const [csvStatus, setCsvStatus] = useState('');
  const [serverBackups, setServerBackups] = useState<ServerBackupMetadata[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [remoteSyncInfo, setRemoteSyncInfo] = useState<RemoteSyncStatusPayload | null>(null);
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
  const [isResettingCaches, setIsResettingCaches] = useState(false);
  const [cacheResetMessage, setCacheResetMessage] = useState('');

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
      setCacheResetMessage('');
      setExcelExportReport(null);
      setVerifiedDownloadInfo(null);
      setDownloadBinaryError(null);
      void fetchSyncStatus().then((info) => {
        if (info) setRemoteSyncInfo(info as RemoteSyncStatusPayload);
      });
    }
  }, [isOpen, activeProfileName, activeProfileId, preferences]);

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

  if (!isOpen) return null;

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

  const handleResetDerivedCaches = async () => {
    setIsResettingCaches(true);
    setCacheResetMessage('');
    try {
      const report = await resetDerivedCachesPreserveProfileAndStock();
      setCacheResetMessage(
        report.ok
          ? '✓ Zevk vektörü (ct:encodings) ve ilişki haritası önbelleği sıfırlandı. İzleme listeniz ve yerel stok havuzunuz korundu.'
          : 'Önbelleklerin bir kısmı sıfırlandı; tam temizlik için sayfayı yenileyebilirsiniz.'
      );
    } catch {
      setCacheResetMessage('Önbellek sıfırlama sırasında bir hata oluştu.');
    } finally {
      setIsResettingCaches(false);
    }
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
    exportMode?: 'xlsx_only' | 'json_and_xlsx';
  }) => {
    setDownloadingBinaryKind(opts.kind);
    setDownloadBinaryError(null);
    const resolvedMode = opts.exportMode || exportingExcelMode || 'xlsx_only';
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
          includeTasteDnaSheet: resolvedMode === 'xlsx_only',
          exportMode: resolvedMode,
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
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Yedek dosyası ikili olarak doğrulanıp indirilemedi.';
      setDownloadBinaryError(message);
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
        includeTasteDnaSheet: mode === 'xlsx_only',
        exportMode: mode,
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
          exportMode: mode,
        });
      }
      if (mode === 'json_and_xlsx' && report.jsonBackup?.ok && report.jsonBackup.downloadUrl) {
        await triggerVerifiedBlobDownload({
          downloadUrl: report.jsonBackup.downloadUrl,
          fileName: report.jsonBackup.fileName || 'CineTrack_Profile.json',
          kind: 'json',
          expectedSizeBytes: report.jsonBackup.sizeBytes,
          expectedSha256: report.jsonBackup.sha256,
          exportMode: mode,
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

  const handleCreateInstantBackup = async () => {
    setLoadingBackups(true);
    setBackupMessage('');
    try {
      const res = await triggerImmediateServerBackup();
      if (res.ok) {
        recordManualBackupSuccess();
        setBackupMessage('Anlık sunucu yedeği başarıyla alındı.');
        if (res.backups && res.backups.length > 0) {
          setServerBackups(res.backups);
        } else {
          const list = await fetchServerBackups();
          setServerBackups(list);
        }
      } else {
        setBackupMessage(`Yedek alınamadı: ${res.message}`);
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
            <h2 id="profileModalTitle" className="detail-title mb-1.5">
              {activeProfileName}
            </h2>
            <div id="profileDescription" className="detail-meta">
              Kişisel izleme istatistikleri, tür analizi ve profil ayarları.
            </div>
          </div>

          <div className="profile-nav-tabs" role="tablist">
            <button
              type="button"
              className={`profile-nav-tab whitespace-nowrap ${activeTab === 'stats' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'stats'}
              onClick={() => setActiveTab('stats')}
            >
              İstatistikler & Analiz
            </button>
            <button
              type="button"
              className={`profile-nav-tab whitespace-nowrap ${activeTab === 'settings' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'settings'}
              onClick={() => setActiveTab('settings')}
            >
              Profil & Ayarlar
            </button>
          </div>

          {activeTab === 'stats' && (
            <ProfileStatsTab
              effectiveActiveProfile={effectiveActiveProfile}
              otherProfiles={otherProfiles}
              savedItems={savedItems}
              genresMap={genresMap}
              tasteEntries={tasteEntries}
            />
          )}

          {activeTab === 'settings' && (
            <form onSubmit={handleProfileNameSubmit} className="grid gap-3.5">
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

              {/* Veri Kaynağı Göstergesi & Geçiş */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3.5 py-2.5 mb-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400">Veri Kaynağı:</span>
                  <strong className={isDemo ? 'text-amber-300' : 'text-emerald-300'}>
                    {isDemo ? 'Demo Modu (Örnek Yapımlar)' : 'Canlı Veri (Kişisel Profil)'}
                  </strong>
                </div>
                {onToggleDemoMode && (
                  <button
                    type="button"
                    onClick={onToggleDemoMode}
                    className="btn btn-sm whitespace-nowrap shrink-0"
                  >
                    {isDemo ? 'Canlı Moda Geç' : 'Demo Moduna Al'}
                  </button>
                )}
              </div>

              {/* IMP-15: Çift Kayıt Temizliği */}
              <DuplicateMergePanel items={savedItems} onMergePair={onMergeDuplicates} />

              {/* Profil Kartları Izgarası */}
              <div className="profile-cards-section">
                <span className="profile-section-label">Profiller</span>
                <div className="profile-cards-grid" role="radiogroup" aria-label="Profiller">
                  {profiles.map((p) => {
                    const isActive = p.id === activeProfileId;
                    const initial = (p.name || 'P').charAt(0).toUpperCase();
                    const itemCount =
                      p.items?.length || (p.id === activeProfileId ? savedItems.length : 0);
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

                  <div className="profile-picker-card profile-card-new">
                    <div className="profile-card-avatar avatar-new" aria-hidden="true">
                      +
                    </div>
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
                        className="btn btn-primary btn-sm whitespace-nowrap"
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

              {/* Yayın Platformları Tercihleri */}
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
                        className={`chip whitespace-nowrap ${isSelected ? 'active' : ''}`}
                        onClick={() => handleProviderToggle(id)}
                        aria-pressed={isSelected}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Ruh Hâli / Öneri Modu */}
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
                className="btn justify-self-start whitespace-nowrap"
                onClick={() => onSavePreferences(selectedProviders, mood)}
              >
                Tercihleri kaydet
              </button>

              {/* Yayın Hatırlatıcıları */}
              <div className="preference-settings">
                <strong>Yayın Hatırlatıcıları</strong>
                <p className="provider-message">
                  Listendeki yapımların vizyona giriş ve yeni bölüm tarihlerinde tarayıcı bildirimi al.
                </p>
                <button
                  type="button"
                  className={`btn whitespace-nowrap ${preferences.reminders ? 'btn-primary' : ''}`}
                  onClick={onToggleReminders}
                >
                  {preferences.reminders ? '✓ Hatırlatıcılar Açık' : 'Hatırlatıcıları Aç'}
                </button>
              </div>

              {/* JSON Yedek Dışa / İçe Aktarma */}
              <div className="profile-backup">
                <button
                  type="button"
                  className="btn whitespace-nowrap shrink-0"
                  onClick={onExportBackup}
                >
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

              {/* Posterli Excel (.xlsx) Profil Yedeği + IMP-14 Zevk İmzası Sekmesi */}
              <div className="profile-tools-section excel-backup-section">
                <strong className="profile-tools-heading">Excel Profil Yedeği (.xlsx)</strong>
                <p className="provider-message">
                  Kişisel film ve dizi arşivinizi gömülü posterlerle birlikte sekmeli (Özet, İzlenen,
                  İzlenecek, İzleniyor, İlgilenmiyorum ve tekli dışa aktarmada Zevk İmzası / tasteDna),
                  filtrelenebilir ve çevrimdışı açılabilir Excel çalışma kitabına aktarır. JSON yedeği
                  birincil geri yükleme biçimi olarak korunur.
                </p>

                <div className="csv-actions-row mt-2.5">
                  <button
                    type="button"
                    className="btn btn-primary whitespace-nowrap shrink-0"
                    disabled={exportingExcelMode !== null}
                    onClick={() => void handleExportFormattedBackup('xlsx_only')}
                  >
                    {exportingExcelMode === 'xlsx_only'
                      ? 'Posterler gömülüyor ve Excel hazırlanıyor…'
                      : 'Excel Profil Yedeği (.xlsx)'}
                  </button>
                  <button
                    type="button"
                    className="btn whitespace-nowrap shrink-0"
                    disabled={exportingExcelMode !== null}
                    onClick={() => void handleExportFormattedBackup('json_and_xlsx')}
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
                  <div className="excel-backup-progress tabular-nums" role="status" aria-live="polite">
                    Poster önbelleği taranıyor ve Excel çalışma kitabı oluşturuluyor (
                    {savedItems.length + preferences.disliked.length} kayıt)…
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
                          <span className="excel-metric-sub">
                            {excelExportReport.jsonBackup.relativePath}
                          </span>
                        )}
                      </div>

                      <div className="excel-metric-cell">
                        <span className="excel-metric-label">Excel Yedeği (.xlsx)</span>
                        <strong className="excel-metric-val">
                          {excelExportReport.excelBackup.ok ? 'Başarılı' : 'Başarısız'}
                        </strong>
                        {excelExportReport.excelBackup.relativePath && (
                          <span className="excel-metric-sub">
                            {excelExportReport.excelBackup.relativePath}
                          </span>
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

              {/* CSV Dışa / İçe Aktar */}
              <div className="profile-tools-section">
                <strong className="profile-tools-heading">
                  CSV İçe / Dışa Aktar (Letterboxd & IMDb)
                </strong>
                <div className="csv-actions-row">
                  <button
                    type="button"
                    className="btn whitespace-nowrap"
                    onClick={handleExportCsv}
                  >
                    CSV Olarak İndir
                  </button>
                  <button
                    type="button"
                    className="btn whitespace-nowrap"
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

              {/* Sunucu Döner Yedekler (Snapshots) & Geri Yükleme */}
              <div className="profile-tools-section">
                <strong className="profile-tools-heading">Sunucu Yedekleri ve Geri Yükleme</strong>
                <div className="csv-actions-row">
                  <button
                    type="button"
                    className="btn btn-primary whitespace-nowrap"
                    disabled={loadingBackups}
                    onClick={() => void handleCreateInstantBackup()}
                  >
                    {loadingBackups ? 'İşleniyor…' : 'Şimdi Yedek Al (Snapshot)'}
                  </button>
                  <button
                    type="button"
                    className="btn whitespace-nowrap"
                    disabled={loadingBackups}
                    onClick={() => void handleLoadServerBackups()}
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
                          <div className="backup-meta tabular-nums">
                            {b.createdAt.slice(0, 19).replace('T', ' ')} · rev-{b.revision} ·{' '}
                            {b.itemsCount} içerik
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm whitespace-nowrap"
                          disabled={loadingBackups}
                          onClick={() => void handleRestoreSnapshot(b.id)}
                        >
                          Bu Yedeğe Dön
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* GitHub Çift Yönlü Senkronizasyon Paneli */}
              <ProfileGitHubSyncSection
                remoteSyncInfo={remoteSyncInfo}
                onRemoteSyncInfoChange={setRemoteSyncInfo}
                profiles={profiles}
                savedItems={savedItems}
                onApplyRestoredDocument={onApplyRestoredDocument}
              />

              {/* REG-03: Türetilmiş Önbellekleri Sıfırla */}
              <div className="profile-tools-section">
                <strong className="profile-tools-heading">Önbellek Bakımı (Vektör & Harita)</strong>
                <p className="cache-reset-note">
                  Zevk vektörü (<code>ct:encodings</code>) ve ilişki haritası önbelleğini temizler. İzleme listenize, profil ayarlarınıza ve yerel stok havuzunuza (<code>ct:stock</code>) dokunulmaz.
                </p>
                <div className="csv-actions-row">
                  <button
                    type="button"
                    className="btn whitespace-nowrap"
                    disabled={isResettingCaches}
                    onClick={() => void handleResetDerivedCaches()}
                  >
                    {isResettingCaches ? 'Önbellekler sıfırlanıyor…' : 'Önbellekleri Sıfırla'}
                  </button>
                </div>
                {cacheResetMessage && <p className="provider-message">{cacheResetMessage}</p>}
              </div>

              <button type="submit" className="btn btn-primary whitespace-nowrap">
                Profil Adını Kaydet ve Kapat
              </button>
            </form>
          )}
        </div>
      </article>
    </div>
  );
};
