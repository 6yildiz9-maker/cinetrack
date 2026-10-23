import React, { useState, useEffect, useRef } from 'react';
import { Profile, Preferences, SavedItem } from '../core/cinetrack-core';
import { PROVIDER_OPTIONS, calculateItemWatchMinutes, getTvShowEpisodesCount } from '../utils/helpers';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';

interface ProfileModalProps {
  isOpen: boolean;
  profiles: Profile[];
  activeProfileId: string;
  activeProfileName: string;
  preferences: Preferences;
  savedItems: SavedItem[];
  genresMap: Record<number, string>;
  syncStatus: string;
  onClose: () => void;
  onSaveProfileName: (name: string) => void;
  onSwitchProfile: (id: string) => void;
  onCreateProfile: (name: string) => void;
  onSavePreferences: (providers: string[], mood: string) => void;
  onToggleReminders: () => void;
  onExportBackup: () => void;
  onImportBackupFile: (file: File) => void;
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
  activeProfileId,
  activeProfileName,
  preferences,
  savedItems,
  genresMap,
  syncStatus,
  onClose,
  onSaveProfileName,
  onSwitchProfile,
  onCreateProfile,
  onSavePreferences,
  onToggleReminders,
  onExportBackup,
  onImportBackupFile,
  isDemo = false,
  onToggleDemoMode,
}) => {
  const [activeTab, setActiveTab] = useState<'stats' | 'settings'>('stats');
  const [genreMediaTypeFilter, setGenreMediaTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [name, setName] = useState(activeProfileName);
  const [selectedProfileId, setSelectedProfileId] = useState(activeProfileId);
  const [newProfileName, setNewProfileName] = useState('');
  const [selectedProviders, setSelectedProviders] = useState<string[]>(preferences.providers);
  const [mood, setMood] = useState<string>(preferences.mood);
  const [importStatus, setImportStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      setName(activeProfileName);
      setSelectedProfileId(activeProfileId);
      setSelectedProviders(preferences.providers);
      setMood(preferences.mood);
      setImportStatus('');
    }
  }, [isOpen, activeProfileName, activeProfileId, preferences]);

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
      if (file.size > 2_000_000) {
        setImportStatus('Yedek dosyası 2 MB sınırını aşamaz.');
        return;
      }
      onImportBackupFile(file);
    }
    e.target.value = '';
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', marginBottom: '5px' }}>
                      <span>🎬 Filmler (%{movieTimePercent})</span>
                      <span>📺 Diziler (%{tvTimePercent})</span>
                    </div>
                    <div style={{ height: '7px', background: '#090d16', borderRadius: '999px', overflow: 'hidden', display: 'flex' }}>
                      <div style={{ width: `${movieTimePercent}%`, background: 'linear-gradient(90deg, #38bdf8, #0284c7)' }} title={`Filmler: ${movieTimeFmt.primary}`}></div>
                      <div style={{ width: `${tvTimePercent}%`, background: 'linear-gradient(90deg, #f43f5e, #fb923c)' }} title={`Diziler: ${tvTimeFmt.primary}`}></div>
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
                        ? 'linear-gradient(90deg, #f43f5e, #fb923c)'
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

              <div className="profile-manage">
                <label htmlFor="switchProfile">
                  Profili değiştir
                  <select
                    id="switchProfile"
                    value={selectedProfileId}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.isDemo ? '(Demo)' : ''} {p.id === activeProfileId ? '(Geçerli)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onSwitchProfile(selectedProfileId)}
                  disabled={selectedProfileId === activeProfileId}
                >
                  Aç
                </button>

                <label htmlFor="newProfileName">
                  Yeni profil oluştur
                  <input
                    id="newProfileName"
                    className="field"
                    type="text"
                    maxLength={40}
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="Örn: Aile, Ortak"
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
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
                <button type="button" className="btn" onClick={onExportBackup}>
                  JSON Yedeği İndir
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  JSON Yedeği Yükle
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
              </div>
              {importStatus && <p className="provider-message" style={{ color: '#fb7185' }}>{importStatus}</p>}

              <button type="submit" className="btn btn-primary" style={{ marginTop: '10px' }}>
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
