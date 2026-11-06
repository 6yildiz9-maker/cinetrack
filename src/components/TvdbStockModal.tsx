import React, { useState, useEffect, useRef } from 'react';
import {
  checkTvdbStatus,
  getStoredTvdbApiKey,
  saveStoredTvdbApiKey,
  syncTvdbStockBatch,
  DEFAULT_TVDB_API_KEY,
  type TvdbStatusResponse,
  type SyncProgressInfo,
} from '../services/tvdb-service.ts';
import {
  exportStockData,
  validateAndParseStockImport,
  applyStockImport,
  type StockSourceFilter,
  type StockExportFormat,
  type StockImportStrategy,
  type StockImportPreview,
} from '../services/stock-import-export.ts';
import { loadStockIdb, type StockDepot } from '../services/storage-idb.ts';

import type { TmdbItem } from '../types/tmdb.ts';

export interface TvdbStockModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStockMutated?: () => void;
  userListItems?: TmdbItem[];
  preferences?: any;
  profileId?: string;
}

export const TvdbStockModal: React.FC<TvdbStockModalProps> = ({
  isOpen,
  onClose,
  onStockMutated,
  userListItems,
  preferences,
  profileId,
}) => {
  const [activeTab, setActiveTab] = useState<'tvdb' | 'import-export'>('tvdb');

  // TVDB Configuration State
  const [apiKey, setApiKey] = useState<string>(() => getStoredTvdbApiKey());
  const [showKey, setShowKey] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [statusResult, setStatusResult] = useState<TvdbStatusResponse | null>(null);

  // Stock counts
  const [stockStats, setStockStats] = useState<{
    totalMovies: number;
    totalTv: number;
    tvdbMovies: number;
    tvdbTv: number;
    tmdbMovies: number;
    tmdbTv: number;
  }>({
    totalMovies: 0,
    totalTv: 0,
    tvdbMovies: 0,
    tvdbTv: 0,
    tmdbMovies: 0,
    tmdbTv: 0,
  });

  // Sync state
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgressInfo | null>(null);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Import / Export State
  const [exportSource, setExportSource] = useState<StockSourceFilter>('tvdb');
  const [exportFormat, setExportFormat] = useState<StockExportFormat>('json');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<StockImportPreview | null>(null);
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [importStrategy, setImportStrategy] = useState<StockImportStrategy>('skip');
  const [isApplyingImport, setIsApplyingImport] = useState<boolean>(false);
  const [importResultNotice, setImportResultNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshStockStats = async () => {
    try {
      const depot: StockDepot = await loadStockIdb();
      const movies = Array.isArray(depot.movies) ? depot.movies : [];
      const tv = Array.isArray(depot.tv) ? depot.tv : [];

      const tvdbM = movies.filter((m) => m.source === 'tvdb').length;
      const tvdbT = tv.filter((t) => t.source === 'tvdb').length;
      const tmdbM = movies.length - tvdbM;
      const tmdbT = tv.length - tvdbT;

      setStockStats({
        totalMovies: movies.length,
        totalTv: tv.length,
        tvdbMovies: tvdbM,
        tvdbTv: tvdbT,
        tmdbMovies: tmdbM,
        tmdbTv: tmdbT,
      });
    } catch {
      // ignore read error
    }
  };

  useEffect(() => {
    if (isOpen) {
      setApiKey(getStoredTvdbApiKey());
      void refreshStockStats();
      void handleTestConnection(getStoredTvdbApiKey());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTestConnection = async (keyToTest?: string) => {
    setIsTesting(true);
    setStatusResult(null);
    try {
      const res = await checkTvdbStatus(keyToTest || apiKey);
      setStatusResult(res);
    } catch (err: any) {
      setStatusResult({
        ok: false,
        configured: Boolean(keyToTest || apiKey),
        tokenActive: false,
        status: 'error',
        status_message: err?.message || 'Bağlantı hatası.',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveApiKey = () => {
    saveStoredTvdbApiKey(apiKey);
    void handleTestConnection(apiKey);
  };

  const handleResetDefaultKey = () => {
    setApiKey(DEFAULT_TVDB_API_KEY);
    saveStoredTvdbApiKey(DEFAULT_TVDB_API_KEY);
    void handleTestConnection(DEFAULT_TVDB_API_KEY);
  };

  const handleStartSync = async () => {
    setIsSyncing(true);
    setSyncSummary(null);
    abortControllerRef.current = new AbortController();

    try {
      const result = await syncTvdbStockBatch({
        apiKey,
        signal: abortControllerRef.current.signal,
        targetCount: 20,
        userListItems,
        preferences,
        profileId,
        onProgress: (info) => {
          setSyncProgress(info);
        },
      });

      if (result.ok) {
        setSyncSummary(
          `Başarılı: ${result.addedMovies} yeni film ve ${result.addedTv} yeni dizi TVDB stoğuna eklendi (En az 20 içerik taraması tamamlandı, ${result.skippedUserListed || 0} kullanıcı listelerindeki yapım hariç tutuldu, ${result.skippedDuplicates} mükerrer kayıt korundu).`
        );
      } else if (result.error === 'İşlem iptal edildi.') {
        setSyncSummary('Senkronizasyon kullanıcı tarafından iptal edildi.');
      } else {
        setSyncSummary(`Uyarı: ${result.error || 'Senkronizasyon tamamlanamadı.'}`);
      }

      await refreshStockStats();
      onStockMutated?.();
    } catch (e: any) {
      setSyncSummary(`Hata oluştu: ${e?.message || 'Bilinmeyen hata'}`);
    } finally {
      setIsSyncing(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelSync = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  // Export Trigger
  const handleExport = async () => {
    setIsExporting(true);
    setExportNotice(null);
    try {
      const res = await exportStockData({ source: exportSource, format: exportFormat });
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportNotice(
        `Dışa aktarma tamamlandı: ${res.count} yapım (${res.moviesCount} film, ${res.tvCount} dizi) "${res.fileName}" olarak indirildi.`
      );
    } catch (e: any) {
      setExportNotice(`Dışa aktarma hatası: ${e?.message || 'Bilinmeyen hata'}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Import File Selection
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportResultNotice(null);
    setIsValidating(true);

    try {
      const text = await file.text();
      const preview = await validateAndParseStockImport(text, file.name);
      setImportPreview(preview);
    } catch (err: any) {
      setImportPreview({
        totalRead: 0,
        validCount: 0,
        invalidCount: 1,
        duplicateCount: 0,
        newCount: 0,
        errors: [{ line: 1, message: err?.message || 'Dosya okunamadı' }],
        validItems: [],
        duplicates: [],
      });
    } finally {
      setIsValidating(false);
    }
  };

  // Import Confirmation
  const handleConfirmImport = async () => {
    if (!importPreview || importPreview.validItems.length === 0) return;
    setIsApplyingImport(true);
    setImportResultNotice(null);

    try {
      const res = await applyStockImport(importPreview.validItems, importStrategy);
      setImportResultNotice(res.message);
      setImportPreview(null);
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      await refreshStockStats();
      onStockMutated?.();
    } catch (e: any) {
      setImportResultNotice(`İçe aktarım hatası: ${e?.message || 'Bilinmeyen hata'}`);
    } finally {
      setIsApplyingImport(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tvdb-modal-title"
    >
      <div
        className="relative w-full max-w-3xl max-h-[92vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl border"
        style={{
          backgroundColor: '#0f1116',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05)',
        }}
      >
        {/* Modal Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{
            backgroundColor: 'rgba(22, 24, 29, 0.85)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs tracking-wider"
              style={{
                backgroundColor: 'rgba(99, 184, 171, 0.15)',
                color: '#63b8ab',
                border: '1px solid rgba(99, 184, 171, 0.3)',
              }}
            >
              TVDB
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 id="tvdb-modal-title" className="text-lg font-semibold text-[#eef0f2] tracking-tight">
                  TheTVDB v4 Entegrasyonu & Stok Yönetimi
                </h2>
                <span
                  className="px-2.5 py-0.5 rounded-full text-xs font-semibold tabular-nums inline-flex items-center gap-1.5"
                  style={{
                    backgroundColor: 'rgba(99, 184, 171, 0.15)',
                    color: '#63b8ab',
                    border: '1px solid rgba(99, 184, 171, 0.35)',
                  }}
                  title={`TVDB Stok: ${stockStats.tvdbMovies} Film, ${stockStats.tvdbTv} Dizi`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#63b8ab]" />
                  TVDB Stoğu: {stockStats.tvdbMovies + stockStats.tvdbTv} Yapım
                </span>
              </div>
              <p className="text-xs text-[#8b9099]">
                Bağımsız TVDB stok kaynağı, 20+ yeni içerik garantili manuel tarama ve kayıpsız yedekle & geri yükle
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-[#8b9099] hover:text-[#eef0f2] hover:bg-white/5 transition-colors"
            title="Kapat"
            aria-label="Kapat"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          className="flex items-center px-6 pt-3 border-b gap-2 shrink-0"
          style={{
            backgroundColor: '#13151a',
            borderColor: 'rgba(255, 255, 255, 0.07)',
          }}
        >
          <button
            onClick={() => setActiveTab('tvdb')}
            className={`px-4 py-2.5 text-xs sm:text-sm font-medium rounded-t-lg transition-all relative ${
              activeTab === 'tvdb'
                ? 'text-[#d3b579] border-b-2 border-[#d3b579]'
                : 'text-[#8b9099] hover:text-[#eef0f2]'
            }`}
          >
            TVDB Entegrasyonu & Senkron ({stockStats.tvdbMovies + stockStats.tvdbTv})
          </button>
          <button
            onClick={() => setActiveTab('import-export')}
            className={`px-4 py-2.5 text-xs sm:text-sm font-medium rounded-t-lg transition-all relative ${
              activeTab === 'import-export'
                ? 'text-[#d3b579] border-b-2 border-[#d3b579]'
                : 'text-[#8b9099] hover:text-[#eef0f2]'
            }`}
          >
            Stok İçe / Dışa Aktar & Geri Yükle
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-[#eef0f2]">
          {activeTab === 'tvdb' ? (
            <>
              {/* API Configuration Card */}
              <div
                className="p-5 rounded-xl border space-y-4"
                style={{
                  backgroundColor: 'rgba(22, 24, 29, 0.62)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#d3b579]" />
                    <h3 className="text-sm font-medium text-[#eef0f2]">TVDB v4 API Anahtarı</h3>
                  </div>

                  {statusResult && (
                    <span
                      className="text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1.5"
                      style={{
                        backgroundColor: statusResult.ok
                          ? 'rgba(111, 191, 138, 0.15)'
                          : 'rgba(224, 100, 94, 0.15)',
                        color: statusResult.ok ? '#6fbf8a' : '#e0645e',
                        border: `1px solid ${
                          statusResult.ok ? 'rgba(111, 191, 138, 0.3)' : 'rgba(224, 100, 94, 0.3)'
                        }`,
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: statusResult.ok ? '#6fbf8a' : '#e0645e' }}
                      />
                      {statusResult.ok ? 'Bağlantı Aktif (JWT)' : 'Bağlantı Başarısız'}
                    </span>
                  )}
                </div>

                <p className="text-xs text-[#8b9099] leading-relaxed">
                  TheTVDB API v4 sunucusu arka plan proxy (/api/tvdb) üzerinden yetkilendirilir. API anahtarınız
                  istemci tarafında doğrudan ifşa edilmez.
                </p>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="TVDB API Key (örn: 2c11dda7-...)"
                        className="w-full px-3.5 py-2.5 bg-[#0a0b0e] border border-white/10 rounded-xl text-sm font-mono text-[#eef0f2] focus:outline-none focus:border-[#d3b579] transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8b9099] hover:text-[#eef0f2]"
                      >
                        {showKey ? 'Gizle' : 'Göster'}
                      </button>
                    </div>

                    <button
                      onClick={handleSaveApiKey}
                      className="px-4 py-2.5 rounded-xl font-medium text-xs bg-[#d3b579] text-[#10120f] hover:bg-[#e2c68f] active:bg-[#b58c4f] transition-colors shrink-0 shadow-sm"
                    >
                      Kaydet
                    </button>

                    <button
                      onClick={() => handleTestConnection(apiKey)}
                      disabled={isTesting}
                      className="px-3.5 py-2.5 rounded-xl text-xs font-medium border border-white/10 hover:border-white/20 bg-white/5 text-[#eef0f2] transition-colors shrink-0 disabled:opacity-50"
                    >
                      {isTesting ? 'Test Ediliyor...' : 'Test Et'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-[#676c75]">
                    <span>PDF Planı Varsayılan Anahtarı: {DEFAULT_TVDB_API_KEY.slice(0, 8)}...</span>
                    <button
                      onClick={handleResetDefaultKey}
                      className="text-[#63b8ab] hover:underline"
                    >
                      Varsayılana Dön
                    </button>
                  </div>
                </div>

                {statusResult && (
                  <div
                    className="p-3 rounded-lg text-xs"
                    style={{
                      backgroundColor: statusResult.ok
                        ? 'rgba(111, 191, 138, 0.08)'
                        : 'rgba(224, 100, 94, 0.08)',
                      color: statusResult.ok ? '#6fbf8a' : '#e0645e',
                      border: `1px solid ${
                        statusResult.ok ? 'rgba(111, 191, 138, 0.2)' : 'rgba(224, 100, 94, 0.2)'
                      }`,
                    }}
                  >
                    {statusResult.status_message}
                  </div>
                )}
              </div>

              {/* Stock Inventory Overview */}
              <div
                className="p-5 rounded-xl border space-y-4"
                style={{
                  backgroundColor: 'rgba(22, 24, 29, 0.62)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-[#eef0f2] flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#63b8ab]" />
                    Mevcut Stok Envanteri
                  </h3>
                  <span className="text-xs text-[#8b9099]">
                    Toplam Depo: {stockStats.totalMovies + stockStats.totalTv} Yapım
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-xl bg-[#0a0b0e] border border-white/5">
                    <div className="text-[11px] text-[#8b9099]">TVDB Filmleri</div>
                    <div className="text-lg font-semibold text-[#63b8ab] mt-1">{stockStats.tvdbMovies}</div>
                    <div className="text-[10px] text-[#676c75]">source: tvdb</div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#0a0b0e] border border-white/5">
                    <div className="text-[11px] text-[#8b9099]">TVDB Dizileri</div>
                    <div className="text-lg font-semibold text-[#63b8ab] mt-1">{stockStats.tvdbTv}</div>
                    <div className="text-[10px] text-[#676c75]">source: tvdb</div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#0a0b0e] border border-white/5">
                    <div className="text-[11px] text-[#8b9099]">TMDB Filmleri</div>
                    <div className="text-lg font-semibold text-[#d3b579] mt-1">{stockStats.tmdbMovies}</div>
                    <div className="text-[10px] text-[#676c75]">source: tmdb</div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#0a0b0e] border border-white/5">
                    <div className="text-[11px] text-[#8b9099]">TMDB Dizileri</div>
                    <div className="text-lg font-semibold text-[#d3b579] mt-1">{stockStats.tmdbTv}</div>
                    <div className="text-[10px] text-[#676c75]">source: tmdb</div>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-[#0a0b0e]/60 border border-white/5 text-xs text-[#8b9099] flex items-start gap-2">
                  <svg className="w-4 h-4 text-[#63b8ab] shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>
                    TVDB stoğu TMDB stoğundan bağımsız etiketlenir. Keşfet ve Zevk Haritası algoritmaları her iki
                    kaynağı da destekler ve TVDB yapımlarına kart üzerinde özel TVDB rozeti eklenir.
                  </span>
                </div>
              </div>

              {/* Manual Sync Section */}
              <div
                className="p-5 rounded-xl border space-y-4"
                style={{
                  backgroundColor: 'rgba(22, 24, 29, 0.62)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-[#eef0f2] flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#a58fd0]" />
                    Manuel Tara & Yeni İçerik Ekle (En Az 20 İçerik)
                  </h3>
                  {isSyncing && (
                    <span className="text-xs text-[#63b8ab] animate-pulse">Tarama ve İndirme Devam Ediyor...</span>
                  )}
                </div>

                <p className="text-xs text-[#8b9099] leading-relaxed">
                  TheTVDB v4 API üzerinden yüksek puanlı ve popüler dizi/filmleri tarar. Her tarama, listenizde veya
                  stoğunuzda olmayan <strong className="text-[#eef0f2]">en az 20 yeni yapım</strong> bulunana kadar
                  sayfalar boyunca taramayı sürdürür.
                </p>

                <div className="p-3.5 rounded-xl bg-[#0a0b0e] border border-white/5 space-y-2 text-xs">
                  <div className="flex items-start gap-2 text-[#8b9099]">
                    <span className="text-[#63b8ab] font-bold">✓</span>
                    <span>
                      <strong className="text-[#eef0f2]">Kullanıcı Listeleri Koruması:</strong> İzleniyor, İzleme Listesi,
                      Tamamlanan veya İlgilenmiyorum listelerinizde yer alan hiçbir yapım stoğa eklenmez, taranan havuzdan
                      otomatik elenir.
                    </span>
                  </div>
                  <div className="flex items-start gap-2 text-[#8b9099]">
                    <span className="text-[#d3b579] font-bold">✓</span>
                    <span>
                      <strong className="text-[#eef0f2]">20+ Yeni İçerik Garantisi:</strong> Hedef 20 benzersiz içerik
                      sağlanana kadar TheTVDB sayfalarında sırayla taranır ve TMDB stoğuna dokunulmadan depoya eklenir.
                    </span>
                  </div>
                </div>

                {isSyncing && syncProgress && (
                  <div className="space-y-2 p-3.5 rounded-xl bg-[#0a0b0e] border border-white/10">
                    <div className="flex justify-between text-xs text-[#8b9099]">
                      <span className="truncate max-w-[70%]">{syncProgress.stepMessage}</span>
                      <span className="font-mono text-[#63b8ab]">{syncProgress.current}%</span>
                    </div>

                    <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${syncProgress.current}%`,
                          background: 'linear-gradient(90deg, #63b8ab 0%, #d3b579 100%)',
                        }}
                      />
                    </div>
                  </div>
                )}

                {syncSummary && (
                  <div className="p-3 rounded-lg text-xs bg-white/5 border border-white/10 text-[#eef0f2]">
                    {syncSummary}
                  </div>
                )}

                <div className="flex items-center gap-3">
                  {!isSyncing ? (
                    <button
                      onClick={handleStartSync}
                      className="px-5 py-2.5 rounded-xl font-medium text-xs bg-[#d3b579] text-[#10120f] hover:bg-[#e2c68f] active:bg-[#b58c4f] transition-all flex items-center gap-2 shadow-sm"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Manuel Tara & Yeni İçerik Ekle (En Az 20 İçerik)
                    </button>
                  ) : (
                    <button
                      onClick={handleCancelSync}
                      className="px-4 py-2.5 rounded-xl font-medium text-xs bg-[#e0645e]/20 text-[#e0645e] border border-[#e0645e]/40 hover:bg-[#e0645e]/30 transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      İptal Et
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Export Section */}
              <div
                className="p-5 rounded-xl border space-y-4"
                style={{
                  backgroundColor: 'rgba(22, 24, 29, 0.62)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-[#eef0f2] flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#63b8ab]" />
                    Stoğu Dışa Aktar
                  </h3>
                </div>

                <p className="text-xs text-[#8b9099] leading-relaxed">
                  CineTrack içerisindeki yerel stok envanterini JSON veya CSV formatında cihazınıza indirin.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-[#8b9099]">Kaynak Filtresi</label>
                    <div className="flex gap-1.5 p-1 rounded-xl bg-[#0a0b0e] border border-white/5">
                      {(['tvdb', 'tmdb', 'all'] as StockSourceFilter[]).map((src) => (
                        <button
                          key={src}
                          type="button"
                          onClick={() => setExportSource(src)}
                          className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                            exportSource === src
                              ? 'bg-[#d3b579] text-[#10120f]'
                              : 'text-[#8b9099] hover:text-[#eef0f2]'
                          }`}
                        >
                          {src === 'tvdb' ? 'Sadece TVDB' : src === 'tmdb' ? 'Sadece TMDB' : 'Tümü'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-[#8b9099]">Dosya Formatı</label>
                    <div className="flex gap-1.5 p-1 rounded-xl bg-[#0a0b0e] border border-white/5">
                      {(['json', 'csv'] as StockExportFormat[]).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => setExportFormat(fmt)}
                          className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                            exportFormat === fmt
                              ? 'bg-[#d3b579] text-[#10120f]'
                              : 'text-[#8b9099] hover:text-[#eef0f2]'
                          }`}
                        >
                          {fmt.toUpperCase()} {fmt === 'json' ? '(Kayıpsız)' : '(Düz Tablo)'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-lg text-xs bg-[#0a0b0e]/70 border border-white/5 text-[#8b9099]">
                  {exportFormat === 'json' ? (
                    <span className="text-[#63b8ab]">
                      ★ JSON formatı önerilir: Bölümler, oyuncular, orijinal başlıklar ve çok dilli veriler
                      kayıpsız saklanır.
                    </span>
                  ) : (
                    <span>
                      CSV formatı Excel/Numbers gibi tablo programlarında incelemek için temel sütunları içerir.
                    </span>
                  )}
                </div>

                {exportNotice && (
                  <div className="p-3 rounded-lg text-xs bg-white/5 border border-white/10 text-[#6fbf8a]">
                    {exportNotice}
                  </div>
                )}

                <button
                  onClick={handleExport}
                  disabled={isExporting}
                  className="px-5 py-2.5 rounded-xl font-medium text-xs bg-[#d3b579] text-[#10120f] hover:bg-[#e2c68f] active:bg-[#b58c4f] transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  {isExporting ? 'Hazırlanıyor...' : 'Dışa Aktar ve İndir'}
                </button>
              </div>

              {/* Import Section */}
              <div
                className="p-5 rounded-xl border space-y-4"
                style={{
                  backgroundColor: 'rgba(22, 24, 29, 0.62)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-[#eef0f2] flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#d3b579]" />
                    Stoğa İçe Aktar
                  </h3>
                </div>

                <p className="text-xs text-[#8b9099] leading-relaxed">
                  Daha önce dışa aktarılmış JSON veya CSV stok dosyasını yükleyin. Yükleme öncesi şema doğrulanır ve
                  çakışan kayıtlar için seçenek sunulur.
                </p>

                {/* Dropzone */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-white/15 hover:border-[#d3b579]/50 rounded-2xl p-6 text-center cursor-pointer transition-colors bg-[#0a0b0e]/50"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.csv"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <svg className="w-8 h-8 text-[#8b9099] mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <div className="text-xs text-[#eef0f2] font-medium">
                    {importFile ? importFile.name : 'Dosya Seçin veya Buraya Sürükleyin (.json, .csv)'}
                  </div>
                  <div className="text-[11px] text-[#676c75] mt-1">
                    {importFile ? `${(importFile.size / 1024).toFixed(1)} KB` : 'JSON ve CSV dosyaları desteklenir'}
                  </div>
                </div>

                {isValidating && (
                  <div className="text-xs text-[#63b8ab] animate-pulse">Dosya şeması doğrulanıyor...</div>
                )}

                {/* Import Preview Card */}
                {importPreview && (
                  <div className="p-4 rounded-xl bg-[#0a0b0e] border border-white/10 space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-[#eef0f2]">Doğrulama Sonucu</span>
                      <span className="text-[#8b9099]">{importPreview.totalRead} satır okundu</span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                        <div className="text-[11px] text-[#8b9099]">Yeni Yapımlar</div>
                        <div className="text-sm font-semibold text-[#6fbf8a]">{importPreview.newCount}</div>
                      </div>
                      <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                        <div className="text-[11px] text-[#8b9099]">Çakışan / Mevcut</div>
                        <div className="text-sm font-semibold text-[#d3b579]">{importPreview.duplicateCount}</div>
                      </div>
                      <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                        <div className="text-[11px] text-[#8b9099]">Hatalı Satırlar</div>
                        <div className="text-sm font-semibold text-[#e0645e]">{importPreview.invalidCount}</div>
                      </div>
                    </div>

                    {importPreview.errors.length > 0 && (
                      <div className="p-2.5 rounded-lg bg-[#e0645e]/10 border border-[#e0645e]/20 text-[11px] text-[#e0645e] max-h-24 overflow-y-auto space-y-1">
                        {importPreview.errors.map((err, idx) => (
                          <div key={idx}>• Satır {err.line}: {err.message}</div>
                        ))}
                      </div>
                    )}

                    {importPreview.validCount > 0 && (
                      <div className="space-y-2 pt-2 border-t border-white/5">
                        <label className="text-xs font-medium text-[#8b9099]">Çakışma / Geri Yükleme Stratejisi</label>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => setImportStrategy('skip')}
                            className={`py-1.5 px-3 text-xs font-medium rounded-lg border transition-colors ${
                              importStrategy === 'skip'
                                ? 'bg-[#d3b579]/15 text-[#d3b579] border-[#d3b579]/40'
                                : 'bg-transparent text-[#8b9099] border-white/10 hover:text-[#eef0f2]'
                            }`}
                          >
                            Mevcutları Koru (Atla)
                          </button>
                          <button
                            type="button"
                            onClick={() => setImportStrategy('overwrite')}
                            className={`py-1.5 px-3 text-xs font-medium rounded-lg border transition-colors ${
                              importStrategy === 'overwrite'
                                ? 'bg-[#d3b579]/15 text-[#d3b579] border-[#d3b579]/40'
                                : 'bg-transparent text-[#8b9099] border-white/10 hover:text-[#eef0f2]'
                            }`}
                          >
                            Üzerine Yaz / Güncelle
                          </button>
                          <button
                            type="button"
                            onClick={() => setImportStrategy('restore')}
                            className={`py-1.5 px-3 text-xs font-medium rounded-lg border transition-colors ${
                              importStrategy === 'restore'
                                ? 'bg-[#63b8ab]/20 text-[#63b8ab] border-[#63b8ab]/50'
                                : 'bg-transparent text-[#8b9099] border-white/10 hover:text-[#eef0f2]'
                            }`}
                          >
                            Yedekten Geri Yükle
                          </button>
                        </div>

                        <p className="text-[11px] text-[#8b9099] italic">
                          {importStrategy === 'restore'
                            ? '★ Geri Yükle: Yüklenen dosyadaki içerikler stoğu tam geri yükler (TVDB yedeği ise yalnızca TVDB yapımlarını günceller).'
                            : importStrategy === 'overwrite'
                            ? '★ Üzerine Yaz: Stoğunuzdaki mevcut eşleşen yapımların detayları yüklenen dosyadaki verilerle güncellenir.'
                            : '★ Mevcutları Koru: Yalnızca stoğunuzda henüz bulunmayan yeni yapımlar eklenir, mevcutlara dokunulmaz.'}
                        </p>

                        <button
                          onClick={handleConfirmImport}
                          disabled={isApplyingImport}
                          className="w-full mt-2 py-2.5 rounded-xl font-medium text-xs bg-[#6fbf8a] text-[#10120f] hover:bg-[#7ed19a] active:bg-[#5da776] transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                        >
                          {isApplyingImport
                            ? 'Stoğa Ekleniyor...'
                            : importStrategy === 'restore'
                            ? `${importPreview.validCount} Yapımı Yedekten Geri Yükle`
                            : `${importPreview.validCount} Yapımı Stoğa Aktar`}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {importResultNotice && (
                  <div className="p-3 rounded-lg text-xs bg-[#6fbf8a]/10 border border-[#6fbf8a]/20 text-[#6fbf8a]">
                    {importResultNotice}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div
          className="flex items-center justify-between px-6 py-3.5 border-t shrink-0 text-xs text-[#8b9099]"
          style={{
            backgroundColor: 'rgba(22, 24, 29, 0.85)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
          }}
        >
          <span>Cinethos • Bağımsız TVDB v4 & TMDB Çoklu Kaynak Kataloğu</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-white/10 text-[#eef0f2] hover:bg-white/5 transition-colors font-medium"
          >
            Kapat
          </button>
        </div>
      </div>
    </div>
  );
};
