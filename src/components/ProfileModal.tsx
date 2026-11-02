import React, { useState, useEffect, useMemo } from 'react';
import type {
  DataDocument,
  FavoriteActorInfo,
  Profile,
  Preferences,
  SavedItem,
} from '../core/cinetrack-core';
import {
  fetchServerBackups,
  fetchSyncStatus,
  restoreServerBackup,
  triggerImmediateServerBackup,
  type ServerBackupMetadata,
} from '../services/api';
import { recordManualBackupSuccess } from '../services/auto-backup-service';
import { resetDerivedCachesPreserveProfileAndStock } from '../services/idb-schema-version';
import { PROVIDER_OPTIONS } from '../utils/helpers';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';
import { ProfileStatsTab } from './ProfileStatsTab';
import { ProfileBackupTab } from './ProfileBackupTab';
import {
  ProfileGitHubSyncSection,
  type RemoteSyncStatusPayload,
} from './ProfileGitHubSyncSection';
import { DuplicateMergePanel } from './DuplicateMergePanel';

export type ProfileModalTabKey = 'stats' | 'profile' | 'backup' | 'sync';

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
  const [activeTab, setActiveTab] = useState<ProfileModalTabKey>('stats');
  const [name, setName] = useState(activeProfileName);
  const [newProfileName, setNewProfileName] = useState('');
  const [selectedProviders, setSelectedProviders] = useState<string[]>(preferences.providers);
  const [mood, setMood] = useState<string>(preferences.mood);
  const [serverBackups, setServerBackups] = useState<ServerBackupMetadata[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [remoteSyncInfo, setRemoteSyncInfo] = useState<RemoteSyncStatusPayload | null>(null);
  const [isResettingCaches, setIsResettingCaches] = useState(false);
  const [cacheResetMessage, setCacheResetMessage] = useState('');

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
      setBackupMessage('');
      setCacheResetMessage('');
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
        className="modal profile-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profileModalTitle"
        aria-describedby="profileDescription"
        tabIndex={-1}
      >
        <header className="profile-modal-header">
          <button className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-close"></use>
            </svg>
          </button>
          <div>
            <h2 id="profileModalTitle" className="detail-title mb-1.5">
              {activeProfileName}
            </h2>
            <div id="profileDescription" className="detail-meta">
              Kişisel izleme istatistikleri, tercihler, yedekleme ve sistem bakımı.
            </div>
          </div>
        </header>

        <nav className="profile-modal-tabs-bar" aria-label="Profil Sekmeleri">
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
              className={`profile-nav-tab whitespace-nowrap ${activeTab === 'profile' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'profile'}
              onClick={() => setActiveTab('profile')}
            >
              Profil & Tercihler
            </button>
            <button
              type="button"
              className={`profile-nav-tab whitespace-nowrap ${activeTab === 'backup' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'backup'}
              onClick={() => setActiveTab('backup')}
            >
              Yedekleme & Aktarım
            </button>
            <button
              type="button"
              className={`profile-nav-tab whitespace-nowrap ${activeTab === 'sync' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'sync'}
              onClick={() => setActiveTab('sync')}
            >
              Eşitleme & Bakım
            </button>
          </div>
        </nav>

        <div className="profile-modal-scrollable-body">
          {activeTab === 'stats' && (
            <ProfileStatsTab
              effectiveActiveProfile={effectiveActiveProfile}
              otherProfiles={otherProfiles}
              savedItems={savedItems}
              genresMap={genresMap}
              tasteEntries={tasteEntries}
            />
          )}

          {activeTab === 'profile' && (
            <div className="profile-tab-panel">
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
                            if (p.id !== activeProfileId) onSwitchProfile(p.id);
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

                <button type="submit" className="btn btn-primary whitespace-nowrap mt-2">
                  Profil Adını Kaydet ve Kapat
                </button>
              </form>
            </div>
          )}

          {activeTab === 'backup' && (
            <div className="profile-tab-panel">
              <ProfileBackupTab
                activeProfileId={activeProfileId}
                effectiveActiveProfile={effectiveActiveProfile}
                savedItems={savedItems}
                preferences={preferences}
                dislikedItems={dislikedItems}
                genresMap={genresMap}
                remoteSyncInfo={remoteSyncInfo}
                serverBackups={serverBackups}
                loadingBackups={loadingBackups}
                backupMessage={backupMessage}
                onExportBackup={onExportBackup}
                onImportBackupFile={onImportBackupFile}
                onImportCsvItems={onImportCsvItems}
                onCreateInstantBackup={handleCreateInstantBackup}
                onLoadServerBackups={handleLoadServerBackups}
                onRestoreSnapshot={handleRestoreSnapshot}
              />
            </div>
          )}

          {activeTab === 'sync' && (
            <div className="profile-tab-panel">
              {/* GitHub Çift Yönlü Senkronizasyon Paneli */}
              <ProfileGitHubSyncSection
                remoteSyncInfo={remoteSyncInfo}
                onRemoteSyncInfoChange={setRemoteSyncInfo}
                profiles={profiles}
                savedItems={savedItems}
                onApplyRestoredDocument={onApplyRestoredDocument}
              />

              {/* IMP-15: Çift Kayıt Temizliği */}
              <DuplicateMergePanel items={savedItems} onMergePair={onMergeDuplicates} />

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
            </div>
          )}
        </div>
      </article>
    </div>
  );
};
