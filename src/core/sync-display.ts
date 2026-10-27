import type { DataDocument } from './cinetrack-core.ts';

export type SyncOperationKind = 'inspect' | 'pull' | 'push' | 'reconcile';

export type SyncFileCategory =
  | 'catalog_movies'
  | 'catalog_tv'
  | 'catalog_manifest'
  | 'user_data'
  | 'derived_profile';

export type SyncErrorCategory =
  | 'config_error'
  | 'network_error'
  | 'rate_limit'
  | 'auth_error'
  | 'conflict'
  | 'not_found'
  | 'corrupt_remote_json'
  | 'corrupt_local_file'
  | 'schema_mismatch'
  | 'payload_too_large'
  | 'malformed_response'
  | 'sync_in_progress'
  | 'http_error';

export interface SyncFileInspection {
  repoPath: string;
  category: SyncFileCategory;
  personal: boolean;
  exists: boolean;
  valid: boolean;
  sizeBytes: number;
  rawFileHash: string | null;
  semanticHash: string | null;
  recordCount: number;
  uniqueKeyCount: number;
  sha?: string;
  error?: string;
  errorCategory?: SyncErrorCategory;
}

export interface SyncSideSummary {
  inspectedAt: string;
  catalogMovieCount: number;
  catalogTvCount: number;
  catalogRawMovieRecords: number;
  catalogRawTvRecords: number;
  catalogContentHash: string | null;
  catalogSemanticHash: string | null;
  manifestPresent: boolean;
  manifestValid: boolean;
  manifestMovieCount: number | null;
  manifestTvCount: number | null;
  manifestContentHash: string | null;
  manifestMismatchReason?: string;
  userDataPresent: boolean;
  userProfilesCount: number;
  userTotalSavedItemsCount: number;
  userUniqueSavedItemsCount: number;
  userDataSemanticHash: string | null;
  userDataRawHash: string | null;
  derivedProfileFilesCount: number;
  derivedProfileTotalRecordsCount: number;
  files: Record<string, SyncFileInspection>;
}

export interface SyncFileDiffDetail {
  repoPath: string;
  category: SyncFileCategory;
  localExists: boolean;
  remoteExists: boolean;
  localValid: boolean;
  remoteValid: boolean;
  localRecords: number;
  remoteRecords: number;
  rawEqual: boolean;
  semanticEqual: boolean;
  reason: string;
}

export interface UserDataConflictItem {
  profileId: string;
  mediaKey: string;
  title: string;
  localStatus?: string;
  remoteStatus?: string;
  localRating?: number | '';
  remoteRating?: number | '';
  resolution: string;
}

export interface SyncComparisonSummary {
  semanticEqual: boolean;
  rawFilesEqual: boolean;
  comparedFilesCount: number;
  differentFilesCount: number;
  differentRecordsCount: number;
  differingFiles: SyncFileDiffDetail[];
  hasUserDataConflict: boolean;
  localOnlyUserItemsCount: number;
  remoteOnlyUserItemsCount: number;
  conflictingUserItemsCount: number;
  userDataConflicts: UserDataConflictItem[];
  reasons: string[];
}

export interface SyncErrorRecord {
  repoPath?: string;
  category: SyncErrorCategory;
  message: string;
  status?: number;
}

export interface PullConflictSummary {
  localProfilesCount: number;
  remoteProfilesCount: number;
  localItemsCount: number;
  remoteItemsCount: number;
  localOnlyItemsCount: number;
  conflictingItemsCount: number;
  message: string;
}

export interface BidirectionalSyncReport {
  ok: boolean;
  partialFailure: boolean;
  requiresConfirmation?: boolean;
  conflictSummary?: PullConflictSummary;
  operation: SyncOperationKind;
  startedAt: string;
  completedAt: string;
  remoteTarget?: {
    owner: string;
    repo: string;
    branch: string;
  };
  isPublicRepo: boolean;
  repoVisibilityWarning?: string;
  localBefore: SyncSideSummary;
  remoteBefore: SyncSideSummary | null;
  localAfter: SyncSideSummary;
  remoteAfter: SyncSideSummary | null;
  comparison: SyncComparisonSummary | null;
  filesDownloaded: string[];
  filesUploaded: string[];
  filesUnchanged: string[];
  filesMerged: string[];
  filesFailed: string[];
  filesPending: string[];
  filesBlockedPublic: string[];
  recordsAdded: number;
  recordsUpdated: number;
  recordsConflicted: number;
  conflicts: UserDataConflictItem[];
  warnings: string[];
  errors: SyncErrorRecord[];
  verifiedEqual: boolean;
  updatedDataDocument?: DataDocument;
  serverRevision?: number;
}

export interface SyncUiBannerState {
  tone: 'synced' | 'partial' | 'diverged' | 'confirm_required' | 'error' | 'idle' | 'unconfigured';
  headline: string;
  detail: string;
  isVerifiedEqual: boolean;
}

/**
 * UI'da gösterilecek senkronizasyon durumunu üretir.
 * KURAL: Yalnızca HTTP 200 döndü diye asla "Tam eşitlendi" üretmez;
 * `verifiedEqual === true && ok === true && errors.length === 0` şartını zorunlu tutar.
 */
export function deriveSyncUiBanner(
  syncStatus: any,
  latestReport?: BidirectionalSyncReport | null
): SyncUiBannerState {
  if (!syncStatus?.configured) {
    return {
      tone: 'unconfigured',
      headline: 'GitHub bağlantısı yapılandırılmadı',
      detail:
        syncStatus?.reason ||
        'Çift yönlü senkronizasyon için sunucu ortamında GitHub token, sahip ve depo bilgileri tanımlanmalıdır.',
      isVerifiedEqual: false,
    };
  }

  if (latestReport) {
    if (latestReport.requiresConfirmation && latestReport.conflictSummary) {
      return {
        tone: 'confirm_required',
        headline: 'Yerel kullanıcı verisini korumak için onayınız gerekiyor',
        detail: latestReport.conflictSummary.message,
        isVerifiedEqual: false,
      };
    }

    if (latestReport.partialFailure) {
      const errMsg = latestReport.errors.map((e) => e.message).join(' | ');
      return {
        tone: 'partial',
        headline: `Kısmi tamamlanma (${latestReport.filesFailed.length} dosya hata aldı)`,
        detail:
          errMsg ||
          'Bazı dosyalar işlendi ancak hata alan dosyalar bulunduğu için tam eşitlik doğrulanmadı.',
        isVerifiedEqual: false,
      };
    }

    if (!latestReport.ok || latestReport.errors.length > 0) {
      const errMsg = latestReport.errors.map((e) => e.message).join(' | ');
      return {
        tone: 'error',
        headline: 'Senkronizasyon işlemi tamamlanamadı',
        detail: errMsg || 'İşlem sırasında beklenmeyen bir hata oluştu.',
        isVerifiedEqual: false,
      };
    }

    if (latestReport.verifiedEqual) {
      return {
        tone: 'synced',
        headline: 'Yerel ve GitHub verileri eşit (Doğrulandı)',
        detail:
          latestReport.comparison?.rawFilesEqual === false
            ? 'Tüm katalog, kullanıcı listesi ve profil kayıtları semantik olarak birebir eşit (yalnızca yazım zaman damgaları farklı).'
            : 'Tüm katalog, kullanıcı listesi ve profil dosyaları yeniden okunarak hem içerik hem özet düzeyinde doğrulandı.',
        isVerifiedEqual: true,
      };
    }

    const diffFiles = latestReport.comparison?.differentFilesCount ?? 0;
    const diffRecords = latestReport.comparison?.differentRecordsCount ?? 0;
    const firstReasons = (latestReport.comparison?.reasons || []).slice(0, 2).join(' · ');

    return {
      tone: 'diverged',
      headline: 'Yerel ve GitHub verileri henüz eşit değil',
      detail: `${diffFiles} dosyada toplam ${diffRecords} kayıt/özet farkı var${
        firstReasons ? ` (${firstReasons})` : ''
      }. Kayıpsız birleştirmek için "İki yönlü eşitle" işlemini kullanabilirsiniz.`,
      isVerifiedEqual: false,
    };
  }

  const lastComparison: SyncComparisonSummary | undefined = syncStatus?.lastComparison;
  const lastError: string | undefined = syncStatus?.lastError;

  if (lastError) {
    return {
      tone: 'error',
      headline: 'Son senkronizasyonda hata algılandı',
      detail: lastError,
      isVerifiedEqual: false,
    };
  }

  if (lastComparison) {
    if (lastComparison.semanticEqual) {
      return {
        tone: 'synced',
        headline: 'Yerel ve GitHub verileri eşit (Son denetimde doğrulandı)',
        detail:
          lastComparison.rawFilesEqual === false
            ? 'Semantik içerik hash değerleri eşit; yalnızca yazım zaman damgalarında fark var.'
            : 'Son denetimde tüm yerel ve uzak dosyaların içerik özetleri eşleşti.',
        isVerifiedEqual: true,
      };
    }

    return {
      tone: 'diverged',
      headline: 'Yerel ve GitHub arasında fark tespit edildi',
      detail: `${lastComparison.differentFilesCount} dosyada ${lastComparison.differentRecordsCount} kayıt/özet farkı mevcut.`,
      isVerifiedEqual: false,
    };
  }

  return {
    tone: 'idle',
    headline: 'Henüz uzak depo doğrulaması yapılmadı',
    detail:
      'GitHub üzerindeki mevcut kayıt sayılarını ve içerik özetlerini görmek için "Durumu denetle" butonunu kullanın.',
    isVerifiedEqual: false,
  };
}
