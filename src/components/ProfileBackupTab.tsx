import React, { useState, useRef } from 'react';
import type { Preferences, Profile, SavedItem } from '../core/cinetrack-core.ts';
import type { CinemaKunyeDocument } from '../core/cinema-kunye.ts';
import { exportItemsToCsv, importItemsFromCsv } from '../core/exporters.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb } from '../core/limits.ts';
import {
  createProfileBackupExport,
  downloadVerifiedBackupBinary,
  type ProfileBackupExportReportClient,
  type ServerBackupMetadata,
} from '../services/api.ts';
import { recordManualBackupSuccess } from '../services/auto-backup-service.ts';
import type { RemoteSyncStatusPayload } from './ProfileGitHubSyncSection.tsx';

interface ProfileBackupTabProps {
  activeProfileId: string;
  effectiveActiveProfile: Profile;
  savedItems: SavedItem[];
  preferences: Preferences;
  dislikedItems?: Array<Record<string, unknown>>;
  genresMap: Record<number, string>;
  cinemaKunye?: CinemaKunyeDocument | null;
  remoteSyncInfo: RemoteSyncStatusPayload | null;
  serverBackups: ServerBackupMetadata[];
  loadingBackups: boolean;
  backupMessage: string;
  onExportBackup: () => void;
  onImportBackupFile: (file: File) => void;
  onImportCsvItems?: (items: SavedItem[], cinemaKunye?: CinemaKunyeDocument) => void;
  onCreateInstantBackup: () => Promise<void>;
  onLoadServerBackups: () => Promise<void>;
  onRestoreSnapshot: (id: string) => Promise<void>;
}

export const ProfileBackupTab: React.FC<ProfileBackupTabProps> = ({
  activeProfileId,
  effectiveActiveProfile,
  savedItems,
  preferences,
  dislikedItems,
  genresMap,
  cinemaKunye,
  remoteSyncInfo,
  serverBackups,
  loadingBackups,
  backupMessage,
  onExportBackup,
  onImportBackupFile,
  onImportCsvItems,
  onCreateInstantBackup,
  onLoadServerBackups,
  onRestoreSnapshot,
}) => {
  const [importStatus, setImportStatus] = useState('');
  const [csvStatus, setCsvStatus] = useState('');
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
    const csvContent = exportItemsToCsv(savedItems, {
      profile: effectiveActiveProfile,
      activeProfileId,
      cinemaKunye,
      genreMap: genresMap,
    });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cinetrack-${activeProfileId}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCsvStatus(
      `${savedItems.length} içerik, sinema künyesi ve tüm profil verileri CSV olarak dışa aktarıldı.`
    );
  };

  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = String(event.target?.result || '');
      try {
        const result = importItemsFromCsv(text);
        const kunyeCount = Object.keys(result.cinemaKunye.entries).length;
        if ((result.importedItems.length > 0 || kunyeCount > 0) && onImportCsvItems) {
          onImportCsvItems(result.importedItems, result.cinemaKunye);
          setCsvStatus(
            `${result.importedItems.length} yapım${
              kunyeCount > 0 ? ` ve ${kunyeCount} sinema künyesi kaydı` : ''
            } kayıpsız birleştirildi (${result.detectedFormat.toUpperCase()} biçimi${
              result.skippedCount > 0 ? `, ${result.skippedCount} satır atlandı` : ''
            }).`
          );
        } else if (result.importedItems.length === 0) {
          setCsvStatus('CSV dosyasında geçerli içerik bulunamadı.');
        }
      } catch {
        setCsvStatus('CSV dosyası çözümlenemedi.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
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
      link.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

      setVerifiedDownloadInfo({
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
        fileName: verified.fileName,
      });
    } catch (err) {
      setDownloadBinaryError(
        err instanceof Error ? err.message : 'İndirilen ikili dosya doğrulanamadı.'
      );
    } finally {
      setDownloadingBinaryKind(null);
    }
  };

  const handleExportFormattedBackup = async (mode: 'xlsx_only' | 'json_and_xlsx') => {
    setExportingExcelMode(mode);
    setExcelExportReport(null);
    setVerifiedDownloadInfo(null);
    setDownloadBinaryError(null);
    try {
      const report = await createProfileBackupExport({
        profileId: activeProfileId,
        exportMode: mode,
        includeTasteDnaSheet: true,
        uploadToGithub: uploadExcelToGithub,
        profileSnapshot: effectiveActiveProfile,
        dislikedItemsHint: dislikedItems,
        genresMap,
      });
      setExcelExportReport(report);
      recordManualBackupSuccess();

      if (report.excelBackup.ok && report.excelBackup.downloadUrl) {
        await triggerVerifiedBlobDownload({
          downloadUrl: report.excelBackup.downloadUrl,
          fileName: report.excelBackup.fileName || 'CineTrack_Profile.xlsx',
          kind: 'xlsx',
          expectedSizeBytes: report.excelBackup.sizeBytes,
          expectedSha256: report.excelBackup.sha256,
          exportMode: mode,
        });
      }
    } catch (err) {
      setDownloadBinaryError(
        err instanceof Error ? err.message : 'Biçimlendirilmiş yedek oluşturulamadı.'
      );
    } finally {
      setExportingExcelMode(null);
    }
  };

  return (
    <div className="profile-tab-panel">
      {/* 1. JSON Yedekleme */}
      <div className="profile-tools-section">
        <strong className="profile-tools-heading">JSON Profil Yedeği</strong>
        <p className="provider-message">
          CineTrack profilinizi, izleme listenizi ve ayarlarınızı standart JSON formatında dışa aktarın veya geri yükleyin.
        </p>
        <div className="csv-actions-row">
          <button
            type="button"
            className="btn btn-primary whitespace-nowrap shrink-0"
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
        {importStatus && <p className="provider-message mt-2">{importStatus}</p>}
      </div>

      {/* 2. Posterli Excel (.xlsx) Profil Yedeği */}
      <div className="profile-tools-section excel-backup-section">
        <strong className="profile-tools-heading">Excel Profil Yedeği (.xlsx)</strong>
        <p className="provider-message">
          Kişisel film ve dizi arşivinizi gömülü posterlerle birlikte sekmeli (Özet, İzlenen,
          İzlenecek, İzleniyor, İlgilenmiyorum ve Zevk İmzası),
          filtrelenebilir ve çevrimdışı açılabilir Excel çalışma kitabına aktarır.
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
          <label className="excel-github-toggle mt-2">
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
          <div className="excel-backup-progress tabular-nums mt-2" role="status" aria-live="polite">
            Poster önbelleği taranıyor ve Excel çalışma kitabı oluşturuluyor (
            {savedItems.length + preferences.disliked.length} kayıt)…
          </div>
        )}

        {excelExportReport && (
          <div className="excel-backup-report tabular-nums mt-3" role="status" aria-live="polite">
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
              <div className="excel-github-outcome mt-2">
                <strong>GitHub Yükleme Durumu:</strong>{' '}
                {excelExportReport.githubUpload.ok && excelExportReport.githubUpload.verifiedReadBack
                  ? `Başarılı ve SHA-256 doğrulandı (${excelExportReport.githubUpload.repoPath})`
                  : excelExportReport.githubUpload.error || 'Yükleme doğrulanamadı.'}
              </div>
            )}

            {verifiedDownloadInfo && (
              <div className="excel-github-outcome mt-2">
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
              <div className="excel-backup-error mt-2">
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

      {/* 3. CSV İçe / Dışa Aktarma */}
      <div className="profile-tools-section">
        <strong className="profile-tools-heading">
          CSV İçe / Dışa Aktar (Letterboxd & IMDb)
        </strong>
        <p className="provider-message">
          İzleme listenizi CSV formatında indirin veya harici platformlardan liste aktarın.
        </p>
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
        {csvStatus && <p className="provider-message mt-2">{csvStatus}</p>}
      </div>

      {/* 4. Sunucu Döner Yedekler (Snapshots) */}
      <div className="profile-tools-section">
        <strong className="profile-tools-heading">Sunucu Yedekleri ve Geri Yükleme</strong>
        <p className="provider-message">
          Sunucuda saklanan otomatik ve anlık yedek noktalarını görüntüleyin veya seçili yedeğe dönün.
        </p>
        <div className="csv-actions-row">
          <button
            type="button"
            className="btn btn-primary whitespace-nowrap"
            disabled={loadingBackups}
            onClick={() => void onCreateInstantBackup()}
          >
            {loadingBackups ? 'İşleniyor…' : 'Şimdi Yedek Al (Snapshot)'}
          </button>
          <button
            type="button"
            className="btn whitespace-nowrap"
            disabled={loadingBackups}
            onClick={() => void onLoadServerBackups()}
          >
            {loadingBackups ? 'Yedekler okunuyor…' : 'Sunucu Yedeklerini Listele'}
          </button>
        </div>
        {backupMessage && <p className="provider-message mt-2">{backupMessage}</p>}
        {serverBackups.length > 0 && (
          <div className="backups-list mt-3">
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
                  onClick={() => void onRestoreSnapshot(b.id)}
                >
                  Bu Yedeğe Dön
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
