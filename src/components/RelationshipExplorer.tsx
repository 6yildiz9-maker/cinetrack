import React, { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  buildRelationshipGraph,
  computeRelationshipPoolSignature,
  computeRelationshipProfileSignature,
  getRelationshipLinkColor,
  getRelationshipNodeColor,
  getRelationshipTypeLabel,
  RELATIONSHIP_GRAPH_SCHEMA_VERSION,
  RELATIONSHIP_MODEL_VERSION,
  relationshipNodeKey,
  type MediaFilter,
  type RelationshipGraphData,
  type RelationshipGraphLink,
  type RelationshipGraphNode,
  type RelationshipMode,
  type RelationshipType,
} from '../core/relationship-explorer';
import {
  loadPersistentPoolData,
  type FavoriteActorInfo,
  type PoolCandidateItem,
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core';
import {
  latestGraphCacheKey,
  readRelationshipCache,
  writeRelationshipCache,
  type RelationshipGraphSnapshot,
} from '../services/relationship-cache';

interface RelationshipExplorerProps {
  mode: RelationshipMode;
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  candidates: PoolCandidateItem[];
  favoriteActors?: FavoriteActorInfo[];
  genreNames?: Record<number, string>;
  onRefresh: (mediaFilter: MediaFilter) => Promise<PoolCandidateItem[]>;
  onOpenDetails?: (item: PoolCandidateItem | SavedItem) => void;
  onQuickSave?: (item: PoolCandidateItem | SavedItem) => void;
}

type RelationFilter = RelationshipType | 'all';

function linkEndpointId(endpoint: string | RelationshipGraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

function readLocalPoolForFilter(profileId: string, filter: MediaFilter): PoolCandidateItem[] {
  return filter === 'all'
    ? [
        ...loadPersistentPoolData(profileId, 'movie').items,
        ...loadPersistentPoolData(profileId, 'tv').items,
      ]
    : loadPersistentPoolData(profileId, filter).items;
}

function getStatusSignalDescription(
  signal: RelationshipGraphNode['statusSignal'],
  status?: string,
): string {
  if (signal === 'completed-history') {
    return 'İzlenmiş geçmiş içerik (puan verilmediyse kişisel uyum nötr kalır)';
  }
  if (signal === 'interest') {
    return status === 'watching' ? 'Şu an izleniyor (ilgi sinyali)' : 'İzleme listesinde (ilgi sinyali)';
  }
  if (signal === 'disliked') return 'İlgilenilmiyor olarak işaretli';
  if (signal === 'hidden') return 'Gizlenmiş içerik';
  return status ? `Listendeki durum: ${status}` : 'Kayıtlı yapım';
}

export const RelationshipExplorer: React.FC<RelationshipExplorerProps> = ({
  mode,
  profileId,
  savedItems,
  preferences,
  candidates,
  favoriteActors = [],
  genreNames = {},
  onRefresh,
  onOpenDetails,
  onQuickSave,
}) => {
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [relationFilter, setRelationFilter] = useState<RelationFilter>('all');
  const [sourceKey, setSourceKey] = useState('');
  const [sourceQuery, setSourceQuery] = useState('');
  const [displayMode, setDisplayMode] = useState<'graph' | 'list'>('graph');
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  const [snapshotCandidates, setSnapshotCandidates] = useState<PoolCandidateItem[]>(candidates);
  const [graphData, setGraphData] = useState<RelationshipGraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<RelationshipGraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cacheNotice, setCacheNotice] = useState('');
  const [isRestoringCache, setIsRestoringCache] = useState(true);
  const [hasGeneratedGraph, setHasGeneratedGraph] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 560 });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);
  const refreshSequenceRef = useRef(0);
  const skipNextFilterRebuildRef = useRef(false);
  const restoredGraphRef = useRef<RelationshipGraphData | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleMotionChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };
    mediaQuery.addEventListener('change', handleMotionChange);
    return () => mediaQuery.removeEventListener('change', handleMotionChange);
  }, []);

  const favoriteActorIds = useMemo(
    () => favoriteActors.map((actor) => actor.id),
    [favoriteActors],
  );

  const currentProfileSignature = useMemo(
    () =>
      computeRelationshipProfileSignature({
        profileId,
        mediaFilter,
        savedItems,
        preferences,
        favoriteActorIds,
      }),
    [profileId, mediaFilter, savedItems, preferences, favoriteActorIds],
  );

  useEffect(() => {
    return () => {
      // Devam eden asenkron sonuçlar artık bu bileşene ait değildir.
      refreshSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const element = containerRef.current;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(420, Math.floor(rect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Profil veya mod değişiminde önce durumu temizle, ardından IndexedDB son snapshot'ı doğrula (TMDB isteği yapmaz).
  useEffect(() => {
    let cancelled = false;
    refreshSequenceRef.current += 1;
    restoredGraphRef.current = null;
    skipNextFilterRebuildRef.current = false;

    setGraphData(null);
    setSnapshotCandidates([]);
    setSelectedNode(null);
    setSourceKey('');
    setError('');
    setCacheNotice('');
    setHasGeneratedGraph(false);
    setIsRestoringCache(true);

    void (async () => {
      try {
        const record = await readRelationshipCache<RelationshipGraphSnapshot>(
          'graphs',
          latestGraphCacheKey(profileId, mode),
        );
        if (cancelled || !record) return;

        const snapshot = record.value;
        if (snapshot.schemaVersion !== RELATIONSHIP_GRAPH_SCHEMA_VERSION) {
          setCacheNotice('Kayıtlı harita eski şema sürümünde. Güncelleme gerekiyor.');
          return;
        }
        if (snapshot.modelVersion !== RELATIONSHIP_MODEL_VERSION) {
          setCacheNotice('İlişki algoritması değişti. Haritayı güncelle.');
          return;
        }

        const currentSignatureForSnapshot = computeRelationshipProfileSignature({
          profileId,
          mediaFilter: snapshot.mediaFilter,
          savedItems,
          preferences,
          favoriteActorIds: favoriteActors.map((actor) => actor.id),
        });
        if (snapshot.profileId !== profileId || snapshot.mode !== mode) return;
        if (snapshot.profileSignature !== currentSignatureForSnapshot) {
          setCacheNotice(
            'Kullanıcı listesi, puanları, favori oyuncuları veya tercihleri değişmiş. Haritayı güncelle.',
          );
          return;
        }

        // Havuz localStorage üzerinden salt okunur biçimde kontrol edilir; bu adım TMDB isteği yapmaz.
        const livePool = readLocalPoolForFilter(profileId, snapshot.mediaFilter);
        const livePoolSignature = computeRelationshipPoolSignature(livePool);
        if (snapshot.poolSignature !== livePoolSignature) {
          setCacheNotice('Yerel aday havuzu değişmiş. Haritayı güncelle.');
          return;
        }

        // Sadece haritada görünen adaylar geri yüklenir; tamamı önbellekten kopyalanmaz.
        const visiblePoolItems = snapshot.visibleItems.filter(
          (item): item is PoolCandidateItem =>
            typeof (item as PoolCandidateItem).poolSource === 'string',
        );

        if (
          snapshot.mediaFilter !== mediaFilter ||
          snapshot.relationshipFilter !== relationFilter ||
          snapshot.sourceKey !== ''
        ) {
          skipNextFilterRebuildRef.current = true;
        }
        restoredGraphRef.current = snapshot.graph;

        setMediaFilter(snapshot.mediaFilter);
        setRelationFilter(snapshot.relationshipFilter);
        setSourceKey(snapshot.sourceKey);
        setSnapshotCandidates(visiblePoolItems);
        setGraphData(snapshot.graph);
        setHasGeneratedGraph(true);
        setCacheNotice(
          `Kayıtlı harita yüklendi · ${new Date(snapshot.savedAt).toLocaleString('tr-TR')}`,
        );
      } catch (cacheErr) {
        // Önbellek kullanılamaması uygulamanın çalışmasını engellemez.
        console.warn('İlişki haritası önbelleği okunamadı:', cacheErr);
      } finally {
        if (!cancelled) setIsRestoringCache(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Bu effect yalnızca profil/mod değişiminde son snapshot'ı yükler.
    // İçerik/tercih değişimleri imza kontrolüyle ayrı işlenir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, mode]);

  const sourceOptions = useMemo(() => {
    const byKey = new Map<string, PoolCandidateItem | SavedItem>();
    for (const item of [...savedItems, ...snapshotCandidates]) {
      if (mediaFilter !== 'all' && item.media_type !== mediaFilter) continue;
      byKey.set(relationshipNodeKey(item), item);
    }
    return [...byKey.values()].sort((a, b) =>
      String(a.title || a.name || '').localeCompare(String(b.title || b.name || ''), 'tr'),
    );
  }, [savedItems, snapshotCandidates, mediaFilter]);

  const filteredSourceOptions = useMemo(() => {
    const normalizedQuery = sourceQuery.trim().toLocaleLowerCase('tr');
    if (!normalizedQuery) return sourceOptions;
    return sourceOptions.filter((item) => {
      const key = relationshipNodeKey(item);
      if (key === sourceKey) return true;
      const title = String(item.title || item.name || '').toLocaleLowerCase('tr');
      return title.includes(normalizedQuery);
    });
  }, [sourceOptions, sourceQuery, sourceKey]);

  // Medya filtresi değiştiğinde seçili kaynak yeni filtreye uymuyorsa ilk geçerli kaynağa geçir ve seçili düğümü temizle
  useEffect(() => {
    if (mode !== 'relationships' || isRestoringCache) return;

    const isCurrentSourceValid = sourceOptions.some(
      (item) => relationshipNodeKey(item) === sourceKey,
    );

    if (!isCurrentSourceValid) {
      const nextSource = sourceOptions[0];
      setSourceKey(nextSource ? relationshipNodeKey(nextSource) : '');
      setSelectedNode(null);
    }
  }, [mode, isRestoringCache, sourceOptions, sourceKey]);

  // Grafik değiştiğinde mevcut seçili düğüm artık grafikte yoksa seçimi temizle
  useEffect(() => {
    if (!selectedNode) return;

    const currentIds = new Set((graphData?.nodes ?? []).map((node) => node.id));
    if (!currentIds.has(selectedNode.id)) {
      setSelectedNode(null);
    }
  }, [graphData, selectedNode?.id]);

  const createGraph = (
    candidateSnapshot: PoolCandidateItem[],
    requestedSourceKey = sourceKey,
  ) => {
    const effectiveSourceKey =
      mode === 'relationships'
        ? sourceOptions.some((item) => relationshipNodeKey(item) === requestedSourceKey)
          ? requestedSourceKey
          : sourceOptions[0]
            ? relationshipNodeKey(sourceOptions[0])
            : ''
        : requestedSourceKey;

    return buildRelationshipGraph({
      mode,
      profileId,
      candidates: candidateSnapshot,
      savedItems,
      preferences,
      mediaFilter,
      sourceKey: effectiveSourceKey,
      relationshipFilter: relationFilter,
      favoriteActorIds,
      genreNames,
      maxNodes: 90,
      maxLinks: 160,
    });
  };

  const handleRefresh = async () => {
    const requestId = ++refreshSequenceRef.current;
    setLoading(true);
    setError('');

    try {
      // TMDB/havuz yükleme yalnızca bu kullanıcı eyleminde çalışır.
      const loadedCandidates = await onRefresh(mediaFilter);
      if (requestId !== refreshSequenceRef.current) return;

      setSnapshotCandidates(loadedCandidates);

      let effectiveSourceKey = sourceKey;
      if (
        mode === 'relationships' &&
        (!effectiveSourceKey ||
          (!loadedCandidates.some((item) => relationshipNodeKey(item) === effectiveSourceKey) &&
            !savedItems.some(
              (item) =>
                relationshipNodeKey(item) === effectiveSourceKey &&
                (mediaFilter === 'all' || item.media_type === mediaFilter),
            )))
      ) {
        const first = [...savedItems, ...loadedCandidates].find(
          (item) => mediaFilter === 'all' || item.media_type === mediaFilter,
        );
        effectiveSourceKey = first ? relationshipNodeKey(first) : '';
        if (effectiveSourceKey !== sourceKey) {
          skipNextFilterRebuildRef.current = true;
          setSourceKey(effectiveSourceKey);
        }
      }

      const nextGraph = buildRelationshipGraph({
        mode,
        profileId,
        candidates: loadedCandidates,
        savedItems,
        preferences,
        mediaFilter,
        sourceKey: effectiveSourceKey,
        relationshipFilter: relationFilter,
        favoriteActorIds,
        genreNames,
        maxNodes: 90,
        maxLinks: 160,
      });

      restoredGraphRef.current = null;
      setGraphData(nextGraph);
      setHasGeneratedGraph(true);
      setCacheNotice('Harita güncellendi (yerel aday havuzu kullanıldı).');
      setSelectedNode((prev) => {
        if (!prev) return null;
        return nextGraph.nodes.find((n) => n.id === prev.id) || null;
      });

      const hasUsefulResult =
        nextGraph.nodes.length > 1 &&
        (mode === 'taste-map' || nextGraph.links.some((link) => link.type !== 'personal'));

      if (!hasUsefulResult) {
        setError(
          mode === 'relationships' && !effectiveSourceKey
            ? 'İlişkileri keşfetmek için lütfen bir kaynak yapım seç.'
            : 'Bu filtre için yeterli ilişki verisi bulunamadı.',
        );
      }
    } catch (err) {
      if (requestId !== refreshSequenceRef.current) return;
      setError(err instanceof Error ? err.message : 'İlişki haritası oluşturulamadı.');
    } finally {
      if (requestId === refreshSequenceRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!graphData) return;
    if (skipNextFilterRebuildRef.current) {
      skipNextFilterRebuildRef.current = false;
      return;
    }

    // Bu efekt yalnızca yerel filtre değişiminde çalışır; TMDB isteği yapmaz.
    restoredGraphRef.current = null;
    const nextGraph = createGraph(snapshotCandidates);
    setGraphData(nextGraph);
    setSelectedNode(null);
    // Bilerek graphData bağımlılığı eklenmiyor; aksi durumda efekt döngüye girer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaFilter, relationFilter, sourceKey]);

  // Güncel grafiği IndexedDB snapshot önbelleğine yaz; profil değişmişse eski grafiği uyar
  useEffect(() => {
    if (!graphData || !hasGeneratedGraph) return;

    if (graphData.profileSignature !== currentProfileSignature) {
      setCacheNotice('Profil değişti; kaydedilmiş grafik eskidi. Haritayı güncelle.');
      return;
    }

    // Önbellekten yeni geri yüklenmiş grafiği aynı verilerle tekrar yazma (kayıt zamanını koru)
    if (restoredGraphRef.current === graphData) {
      return;
    }

    const graphNodeIds = new Set(
      graphData.nodes.filter((node) => node.mediaType !== 'profile').map((node) => node.id),
    );
    const visibleByKey = new Map<string, PoolCandidateItem | SavedItem>();
    // Önce adayları ekle, sonra kayıtlı öğeleri ekleyerek kullanıcı durumunu koru.
    for (const item of [...snapshotCandidates, ...savedItems]) {
      const key = relationshipNodeKey(item);
      if (graphNodeIds.has(key)) visibleByKey.set(key, item);
    }

    const localPool = readLocalPoolForFilter(profileId, mediaFilter);
    const poolForSignature =
      localPool.length > 0
        ? localPool
        : snapshotCandidates.filter(
            (item) => mediaFilter === 'all' || item.media_type === mediaFilter,
          );

    const snapshot: RelationshipGraphSnapshot = {
      schemaVersion: RELATIONSHIP_GRAPH_SCHEMA_VERSION,
      profileId,
      mode,
      mediaFilter,
      sourceKey,
      relationshipFilter: relationFilter,
      profileSignature: currentProfileSignature,
      poolSignature: computeRelationshipPoolSignature(poolForSignature),
      modelVersion: RELATIONSHIP_MODEL_VERSION,
      savedAt: Date.now(),
      graph: graphData,
      visibleItems: [...visibleByKey.values()],
    };

    void writeRelationshipCache('graphs', latestGraphCacheKey(profileId, mode), snapshot).catch(
      (cacheErr) => {
        console.warn('İlişki haritası önbelleğe yazılamadı:', cacheErr);
      },
    );
  }, [
    graphData,
    hasGeneratedGraph,
    currentProfileSignature,
    profileId,
    mode,
    mediaFilter,
    sourceKey,
    relationFilter,
    savedItems,
    snapshotCandidates,
  ]);

  useEffect(() => {
    if (displayMode !== 'graph') return undefined;
    if (graphData && graphRef.current) {
      if (typeof graphRef.current.d3Force === 'function') {
        const linkForce: any = graphRef.current.d3Force('link');
        if (linkForce && typeof linkForce.distance === 'function') {
          linkForce.distance((link: any) => Number(link.distance || 110));
        }
      }
      if (typeof graphRef.current.zoomToFit === 'function') {
        const duration = prefersReducedMotion ? 0 : 350;
        const timer = window.setTimeout(() => graphRef.current?.zoomToFit?.(duration, 48), 60);
        return () => window.clearTimeout(timer);
      }
    }
    return undefined;
  }, [graphData, displayMode, prefersReducedMotion]);

  const nodeTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graphData?.nodes ?? []) {
      map.set(node.id, node.title);
    }
    return map;
  }, [graphData]);

  const selectedItem = selectedNode
    ? [...snapshotCandidates, ...savedItems].find(
        (item) => relationshipNodeKey(item) === selectedNode.id,
      )
    : undefined;

  const selectedLinks: RelationshipGraphLink[] =
    graphData?.links.filter(
      (link) =>
        linkEndpointId(link.source) === selectedNode?.id ||
        linkEndpointId(link.target) === selectedNode?.id,
    ) || [];

  const hasUsefulGraph = Boolean(
    graphData &&
      graphData.nodes.length > 1 &&
      (mode === 'taste-map' || graphData.links.some((link) => link.type !== 'personal')),
  );

  const visibleContentNodeCount = graphData
    ? graphData.nodes.filter((node) => node.mediaType !== 'profile').length
    : 0;

  const listNodes = useMemo(() => {
    if (!graphData) return [];
    return graphData.nodes
      .filter((node) => node.mediaType !== 'profile')
      .map((node) => {
        const nodeLinks = graphData.links.filter(
          (link) =>
            linkEndpointId(link.source) === node.id || linkEndpointId(link.target) === node.id,
        );
        const topLinkScore = nodeLinks.reduce((max, l) => Math.max(max, Number(l.score || 0)), 0);
        return { node, links: nodeLinks, topLinkScore };
      })
      .sort((a, b) => {
        if (a.node.kind === 'source' && b.node.kind !== 'source') return -1;
        if (b.node.kind === 'source' && a.node.kind !== 'source') return 1;
        if (b.topLinkScore !== a.topLinkScore) return b.topLinkScore - a.topLinkScore;
        return b.node.personalScore - a.node.personalScore;
      });
  }, [graphData]);

  const liveAnnouncement = selectedNode
    ? `Seçili düğüm: ${selectedNode.title}. Kişisel uyum yüzde ${selectedNode.personalScore}. ${selectedLinks.length} bağlantı kanıtı listeleniyor.`
    : '';

  const nodeCanvasObject = (
    rawNode: any,
    ctx: CanvasRenderingContext2D,
    globalScale: number,
  ) => {
    const node = rawNode as RelationshipGraphNode & { x?: number; y?: number };
    const x = node.x || 0;
    const y = node.y || 0;
    const radius =
      (node.kind === 'profile' || node.kind === 'source' ? 10 : 6 + node.personalScore / 35) +
      Math.max(0, node.statusWeight || 0) * 1.5;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = getRelationshipNodeColor(node);
    ctx.globalAlpha = node.id === selectedNode?.id ? 1 : 0.88;
    ctx.fill();
    ctx.globalAlpha = 1;

    // İzleme geçmişi ve ilgi durumunu kişisel uyum puanından bağımsız dış halka olarak çiz
    if (node.statusSignal === 'completed-history' || node.statusSignal === 'interest') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius + 2.2, 0, 2 * Math.PI, false);
      ctx.lineWidth = 1.25;
      if (node.statusSignal === 'interest') {
        ctx.setLineDash([2.5, 2]);
        ctx.strokeStyle = '#fbbf24';
      } else {
        ctx.strokeStyle = '#7dd3fc';
      }
      ctx.stroke();
      ctx.restore();
    }

    if (node.id === selectedNode?.id) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, 0, 2 * Math.PI, false);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#f8fafc';
      ctx.stroke();
      ctx.restore();
    }

    if (globalScale > 0.7 || node.id === selectedNode?.id) {
      const fontSize = Math.max(4, Math.min(12, 10 / globalScale));
      ctx.font = `${node.id === selectedNode?.id ? '600 ' : ''}${fontSize}px Inter, Arial, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#dbeafe';
      ctx.fillText(node.label, x + radius + 4, y);
    }
  };

  return (
    <section className="relationship-explorer">
      <div className="relationship-toolbar">
        <div>
          <h2>{mode === 'taste-map' ? 'Zevk Haritası' : 'İlişki Keşfi'}</h2>
          <p>
            {mode === 'taste-map'
              ? 'Merkezden uzaklık kişisel uyumu, çizgiler ise özet, tür, kadro ve seri metaverisine dayalı ilişkileri gösterir.'
              : 'Bir kaynak yapım seç; bağlantı türü, metaveri kanıtı ve kişisel uyumunu ayrı ayrı incele.'}
          </p>
        </div>
        <button
          className="btn btn-primary"
          type="button"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? 'Harita hazırlanıyor…' : 'Haritayı Güncelle'}
        </button>
      </div>

      {cacheNotice && (
        <p className="relationship-cache-notice" role="status">
          {cacheNotice}
        </p>
      )}
      {isRestoringCache && (
        <p className="relationship-muted" role="status">
          Kayıtlı harita kontrol ediliyor…
        </p>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {mode === 'relationships' && (
        <div className="relationship-view-toggle" role="group" aria-label="İlişki keşfi görünüm modu">
          <button
            className={`btn ${displayMode === 'graph' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => setDisplayMode('graph')}
            aria-pressed={displayMode === 'graph'}
          >
            Ağ haritası
          </button>
          <button
            className={`btn ${displayMode === 'list' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => setDisplayMode('list')}
            aria-pressed={displayMode === 'list'}
          >
            Liste görünümü
          </button>
        </div>
      )}

      <div className="relationship-filters">
        <label>
          İçerik türü
          <select
            value={mediaFilter}
            onChange={(event) => {
              setSelectedNode(null);
              setMediaFilter(event.target.value as MediaFilter);
            }}
          >
            <option value="all">Film + dizi</option>
            <option value="movie">Sadece film</option>
            <option value="tv">Sadece dizi</option>
          </select>
        </label>

        {mode === 'relationships' && (
          <>
            {sourceOptions.length > 8 && (
              <label>
                Kaynak filtrele
                <input
                  type="search"
                  className="relationship-source-search"
                  value={sourceQuery}
                  onChange={(event) => setSourceQuery(event.target.value)}
                  placeholder="Kaynak yapım ara…"
                  aria-label="Kaynak yapım listesini filtrele"
                />
              </label>
            )}
            <label>
              Kaynak yapım
              <select
                value={sourceKey}
                onChange={(event) => {
                  setSelectedNode(null);
                  setSourceKey(event.target.value);
                }}
              >
                <option value="">Kaynak seç…</option>
                {filteredSourceOptions.map((item) => (
                  <option key={relationshipNodeKey(item)} value={relationshipNodeKey(item)}>
                    {item.title || item.name || 'Başlıksız'}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <label>
          İlişki türü
          <select
            value={relationFilter}
            onChange={(event) => {
              setSelectedNode(null);
              setRelationFilter(event.target.value as RelationFilter);
            }}
          >
            <option value="all">Tüm ilişkiler</option>
            <option value="semantic">Anlamsal benzerlik (özet/tür)</option>
            <option value="person">Kişi bağlantısı</option>
            <option value="universe">Seri / evren</option>
            {mode === 'taste-map' && <option value="personal">Kişisel uyum</option>}
          </select>
        </label>
      </div>

      <p className="relationship-muted">
        {graphData
          ? `${visibleContentNodeCount} düğüm ve ${graphData.links.length} bağlantı gösteriliyor. Bu görünüm aday havuzunun seçilmiş bir bölümüdür.`
          : 'Harita henüz oluşturulmadı.'}
      </p>

      {error && (
        <div className="relationship-message" role="status">
          {error}
        </div>
      )}

      <div className="relationship-layout">
        <div
          className={displayMode === 'list' && mode === 'relationships' ? 'relationship-list-container' : 'relationship-graph'}
          ref={containerRef}
        >
          {hasUsefulGraph && graphData ? (
            displayMode === 'list' && mode === 'relationships' ? (
              <div className="relationship-list-view" role="list" aria-label="İlişkili yapımlar listesi">
                {listNodes.map(({ node, links }) => {
                  const isSelected = selectedNode?.id === node.id;
                  const itemObj = [...snapshotCandidates, ...savedItems].find(
                    (it) => relationshipNodeKey(it) === node.id,
                  );
                  return (
                    <article
                      key={node.id}
                      role="listitem"
                      className={`relationship-list-card ${isSelected ? 'is-selected' : ''}`}
                    >
                      <div className="relationship-list-card-head">
                        <button
                          type="button"
                          className="relationship-list-select-btn"
                          onClick={() => setSelectedNode(node)}
                          aria-pressed={isSelected}
                        >
                          <span className="relationship-list-title">{node.title}</span>
                          <span className="relationship-list-badges">
                            <span className="relationship-list-badge">
                              {node.mediaType === 'tv' ? 'Dizi' : 'Film'}
                            </span>
                            {node.kind === 'source' && (
                              <span className="relationship-list-badge is-source">Kaynak Yapım</span>
                            )}
                            <span className="relationship-list-badge is-score">
                              %{node.personalScore} Uyum
                            </span>
                          </span>
                        </button>
                      </div>

                      {links.length > 0 && (
                        <ul className="relationship-list-links">
                          {links.slice(0, 3).map((lnk, idx) => {
                            const sId = linkEndpointId(lnk.source);
                            const tId = linkEndpointId(lnk.target);
                            const otherTitle = nodeTitleById.get(sId === node.id ? tId : sId);
                            return (
                              <li key={`${node.id}-lnk-${idx}`}>
                                <strong>{getRelationshipTypeLabel(lnk.type)}</strong> ({lnk.score}/100)
                                {otherTitle ? ` · ${otherTitle}` : ''}
                                {lnk.evidence[0] ? ` — ${lnk.evidence[0]}` : ''}
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      <div className="relationship-list-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setSelectedNode(node)}
                        >
                          Kanıtları İncele
                        </button>
                        {itemObj && onOpenDetails && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => onOpenDetails(itemObj)}
                          >
                            Ayrıntılar
                          </button>
                        )}
                        {itemObj && onQuickSave && node.kind === 'candidate' && (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => onQuickSave(itemObj)}
                          >
                            Listeye Ekle
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <ForceGraph2D
                ref={graphRef}
                graphData={graphData as any}
                width={size.width}
                height={size.height}
                backgroundColor="#071321"
                nodeRelSize={6}
                nodeCanvasObject={nodeCanvasObject}
                nodeLabel={(rawNode: any) => {
                  const node = rawNode as RelationshipGraphNode;
                  return `${node.title}\nKişisel uyum: ${node.personalScore}/100`;
                }}
                onNodeClick={(rawNode: any) => setSelectedNode(rawNode as RelationshipGraphNode)}
                linkColor={(link: any) => getRelationshipLinkColor(link.type)}
                linkWidth={(link: any) => Math.max(1, Number(link.score || 0) / 42)}
                linkLabel={(rawLink: any) => {
                  const link = rawLink as RelationshipGraphLink;
                  return `${getRelationshipTypeLabel(link.type)} · ${link.score}/100 · Kanıt güveni ${link.confidence}/100\n${link.evidence.join('\n')}`;
                }}
                linkDirectionalParticles={prefersReducedMotion ? 0 : 1}
                linkDirectionalParticleWidth={1.5}
                cooldownTicks={prefersReducedMotion ? 1 : 100}
                d3VelocityDecay={0.3}
                onEngineStop={() => graphRef.current?.pauseAnimation?.()}
              />
            )
          ) : (
            <div className="relationship-empty">
              <div className="relationship-empty-icon" aria-hidden="true">
                <svg className="icon">
                  <use href={graphData ? '#icon-search' : '#icon-network'}></use>
                </svg>
              </div>
              {graphData && (
                <div className="relationship-empty-badge">
                  {visibleContentNodeCount} düğüm · {graphData.links.length} bağlantı
                </div>
              )}
              <h3>
                {mode === 'relationships' && !sourceKey
                  ? 'Kaynak yapım seçilmedi'
                  : graphData && graphData.nodes.length <= 1
                    ? 'Bu yapım için yeterli ilişki bulunamadı'
                    : graphData
                      ? 'Bu filtrede gösterilecek ilişki yok'
                      : 'Harita henüz oluşturulmadı'}
              </h3>
              <p>
                {graphData
                  ? 'Daha geniş bir ilişki filtresi deneyebilir veya farklı bir kaynak yapım seçebilirsin.'
                  : 'Yerel aday havuzunu kullanmak için “Haritayı Güncelle” düğmesine bas.'}
              </p>
              <div className="relationship-empty-actions">
                {graphData && (mediaFilter !== 'all' || relationFilter !== 'all') && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setSelectedNode(null);
                      setMediaFilter('all');
                      setRelationFilter('all');
                    }}
                  >
                    Filtreleri Sıfırla
                  </button>
                )}
                {mode === 'relationships' && !sourceKey && sourceOptions[0] && (
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => {
                      setSelectedNode(null);
                      setSourceKey(relationshipNodeKey(sourceOptions[0]));
                    }}
                  >
                    İlk Kaynağı Seç ({sourceOptions[0].title || sourceOptions[0].name})
                  </button>
                )}
                <button
                  className={`btn ${mode === 'relationships' && !sourceKey && sourceOptions[0] ? '' : 'btn-primary'}`}
                  type="button"
                  onClick={handleRefresh}
                  disabled={loading}
                >
                  {loading
                    ? 'Harita hazırlanıyor…'
                    : graphData
                      ? 'Yeniden Dene'
                      : 'Haritayı Güncelle'}
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="relationship-details">
          <h3>{selectedNode?.title || 'Düğüm ayrıntıları'}</h3>
          {selectedNode ? (
            <>
              <p className="relationship-score">
                Kişisel uyum: <strong>{selectedNode.personalScore}/100</strong>
              </p>
              <p className="relationship-muted">
                {selectedNode.kind === 'saved'
                  ? getStatusSignalDescription(selectedNode.statusSignal, selectedNode.status)
                  : selectedNode.kind === 'profile'
                    ? 'Kullanıcı profili'
                    : selectedNode.kind === 'source'
                      ? selectedNode.status
                        ? `Seçilmiş kaynak yapım · ${getStatusSignalDescription(selectedNode.statusSignal, selectedNode.status)}`
                        : 'Seçilmiş kaynak yapım'
                      : 'Keşif adayı'}
              </p>
              {selectedLinks.map((link, linkIndex) => {
                const srcId = linkEndpointId(link.source);
                const tgtId = linkEndpointId(link.target);
                const counterpartId = srcId === selectedNode.id ? tgtId : srcId;
                const counterpartTitle = nodeTitleById.get(counterpartId);

                const details = link.relationshipDetails?.length
                  ? link.relationshipDetails
                  : [
                      {
                        type: link.type,
                        score: link.score,
                        confidence: link.confidence,
                        evidence: link.evidence,
                      },
                    ];

                return details.map((detail, detailIndex) => (
                  <div
                    className="relationship-evidence"
                    key={`${linkIndex}-${detail.type}-${detailIndex}`}
                  >
                    {counterpartTitle && (
                      <span className="relationship-counterpart">
                        Bağlantı: {counterpartTitle}
                      </span>
                    )}
                    <strong>
                      {getRelationshipTypeLabel(detail.type)} · {detail.score}/100
                    </strong>
                    <span>
                      Kanıt güveni: {detail.confidence}/100
                      {detail.type === 'semantic' ? ' · Özet ve tür verisine dayalı' : ''}
                    </span>
                    <ul>
                      {detail.evidence.map((evidence) => (
                        <li key={evidence}>{evidence}</li>
                      ))}
                    </ul>
                  </div>
                ));
              })}
              <div className="relationship-detail-actions">
                {selectedItem && onOpenDetails && selectedNode.mediaType !== 'profile' && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onOpenDetails(selectedItem)}
                  >
                    İçerik ayrıntısını aç
                  </button>
                )}
                {selectedItem && onQuickSave && selectedNode.kind === 'candidate' && (
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => onQuickSave(selectedItem)}
                  >
                    Listeye ekle
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="relationship-muted">
              Haritadaki bir düğüme tıklayarak kişisel uyumunu ve bağlantı kanıtlarını ayrı ayrı incele.
            </p>
          )}
          <div className="relationship-legend">
            <span>
              <i className="legend-dot legend-dot-profile" /> Kullanıcı profili
            </span>
            <span>
              <i className="legend-dot legend-dot-saved" /> Kayıtlı yapım (düz halka: izlendi, kesikli: listede)
            </span>
            <span>
              <i className="legend-dot legend-dot-match" /> Yüksek kişisel uyum
            </span>
            <span>
              <i className="legend-line legend-line-semantic" /> Özet / tür benzerliği
            </span>
            <span>
              <i className="legend-line legend-line-person" /> Kişi bağlantısı
            </span>
            <span>
              <i className="legend-line legend-line-universe" /> Seri / evren
            </span>
          </div>
        </aside>
      </div>
    </section>
  );
};

export default RelationshipExplorer;

