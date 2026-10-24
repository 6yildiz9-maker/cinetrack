import React, { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  buildRelationshipGraph,
  getRelationshipLinkColor,
  getRelationshipNodeColor,
  getRelationshipTypeLabel,
  relationshipNodeKey,
  type MediaFilter,
  type RelationshipGraphData,
  type RelationshipGraphLink,
  type RelationshipGraphNode,
  type RelationshipMode,
  type RelationshipType,
} from '../core/relationship-explorer';
import type { PoolCandidateItem, Preferences, SavedItem } from '../core/cinetrack-core';

interface RelationshipExplorerProps {
  mode: RelationshipMode;
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  candidates: PoolCandidateItem[];
  onRefresh: (mediaFilter: MediaFilter) => Promise<PoolCandidateItem[]>;
  onOpenDetails?: (item: PoolCandidateItem | SavedItem) => void;
  onQuickSave?: (item: PoolCandidateItem | SavedItem) => void;
}

type RelationFilter = RelationshipType | 'all';

function linkEndpointId(endpoint: string | RelationshipGraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

export const RelationshipExplorer: React.FC<RelationshipExplorerProps> = ({
  mode,
  profileId,
  savedItems,
  preferences,
  candidates,
  onRefresh,
  onOpenDetails,
  onQuickSave,
}) => {
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [relationFilter, setRelationFilter] = useState<RelationFilter>('all');
  const [sourceKey, setSourceKey] = useState('');
  const [snapshotCandidates, setSnapshotCandidates] = useState<PoolCandidateItem[]>(candidates);
  const [graphData, setGraphData] = useState<RelationshipGraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<RelationshipGraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 800, height: 560 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);

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

  useEffect(() => {
    setGraphData(null);
    setSnapshotCandidates([]);
    setSelectedNode(null);
    setSourceKey('');
    setError('');
  }, [profileId, mode]);

  const sourceOptions = useMemo(() => {
    const byKey = new Map<string, PoolCandidateItem | SavedItem>();
    for (const item of [...savedItems, ...snapshotCandidates]) {
      if (mediaFilter !== 'all' && item.media_type !== mediaFilter) continue;
      byKey.set(relationshipNodeKey(item), item);
    }
    return [...byKey.values()].sort((a, b) =>
      String(a.title || a.name || '').localeCompare(String(b.title || b.name || ''), 'tr')
    );
  }, [savedItems, snapshotCandidates, mediaFilter]);

  // Medya filtresi değiştiğinde seçili kaynak yeni filtreye uymuyorsa ilk geçerli kaynağa geçir ve seçili düğümü temizle
  useEffect(() => {
    if (mode !== 'relationships') return;

    const isCurrentSourceValid = sourceOptions.some(
      (item) => relationshipNodeKey(item) === sourceKey
    );

    if (!isCurrentSourceValid) {
      const nextSource = sourceOptions[0];
      setSourceKey(nextSource ? relationshipNodeKey(nextSource) : '');
      setSelectedNode(null);
    }
  }, [mode, sourceOptions, sourceKey]);

  const createGraph = (
    candidateSnapshot: PoolCandidateItem[],
    requestedSourceKey = sourceKey,
  ) => {
    const effectiveSourceKey =
      mode === 'relationships'
        ? (sourceOptions.some((item) => relationshipNodeKey(item) === requestedSourceKey)
            ? requestedSourceKey
            : (sourceOptions[0] ? relationshipNodeKey(sourceOptions[0]) : ''))
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
      maxNodes: 90,
      maxLinks: 160,
    });
  };

  const handleRefresh = async () => {
    setLoading(true);
    setError('');
    try {
      // TMDB/havuz yükleme yalnızca bu kullanıcı eyleminde çalışır.
      const loadedCandidates = await onRefresh(mediaFilter);
      setSnapshotCandidates(loadedCandidates);

      let effectiveSourceKey = sourceKey;
      if (
        mode === 'relationships'
        && (!effectiveSourceKey
          || (!loadedCandidates.some((item) => relationshipNodeKey(item) === effectiveSourceKey)
              && !savedItems.some((item) => relationshipNodeKey(item) === effectiveSourceKey && (mediaFilter === 'all' || item.media_type === mediaFilter))))
      ) {
        const first = [...savedItems, ...loadedCandidates].find(
          (item) => mediaFilter === 'all' || item.media_type === mediaFilter
        );
        effectiveSourceKey = first ? relationshipNodeKey(first) : '';
        setSourceKey(effectiveSourceKey);
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
        maxNodes: 90,
        maxLinks: 160,
      });

      setGraphData(nextGraph);
      setSelectedNode(null);
      if (!nextGraph.nodes.length) {
        if (mode === 'relationships' && !effectiveSourceKey) {
          setError('İlişkileri keşfetmek için lütfen bir kaynak yapım seçin.');
        } else {
          setError('Bu filtre için yeterli ilişki verisi bulunamadı.');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'İlişki haritası oluşturulamadı.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!graphData) return;
    // Filtreler değiştiğinde sadece önbellekteki adaylarla yerel puanlama yapılır; TMDB isteği yapılmaz.
    setGraphData(createGraph(snapshotCandidates));
    // Bilerek graphData bağımlılığı eklenmiyor; aksi durumda efekt döngüye girer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaFilter, relationFilter, sourceKey]);

  useEffect(() => {
    if (graphData && graphRef.current) {
      if (typeof graphRef.current.d3Force === 'function') {
        const linkForce: any = graphRef.current.d3Force('link');
        if (linkForce && typeof linkForce.distance === 'function') {
          linkForce.distance((link: any) => Number(link.distance || 110));
        }
      }
      if (typeof graphRef.current.zoomToFit === 'function') {
        const timer = window.setTimeout(() => graphRef.current?.zoomToFit?.(350, 48), 60);
        return () => window.clearTimeout(timer);
      }
    }
    return undefined;
  }, [graphData]);

  const selectedItem = selectedNode
    ? [...snapshotCandidates, ...savedItems].find(
        (item) => relationshipNodeKey(item) === selectedNode.id
      )
    : undefined;

  const selectedLinks: RelationshipGraphLink[] = graphData?.links.filter((link) =>
    linkEndpointId(link.source) === selectedNode?.id
    || linkEndpointId(link.target) === selectedNode?.id
  ) || [];

  const nodeCanvasObject = (rawNode: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as RelationshipGraphNode & { x?: number; y?: number };
    const x = node.x || 0;
    const y = node.y || 0;
    const radius = node.kind === 'profile' || node.kind === 'source' ? 10 : 6 + node.personalScore / 35;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = getRelationshipNodeColor(node);
    ctx.globalAlpha = node.id === selectedNode?.id ? 1 : 0.88;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (globalScale > 0.7 || node.id === selectedNode?.id) {
      const fontSize = Math.max(4, Math.min(12, 10 / globalScale));
      ctx.font = `${node.id === selectedNode?.id ? '600 ' : ''}${fontSize}px Inter, Arial, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#dbeafe';
      ctx.fillText(node.label, x + radius + 3, y);
    }
  };

  return (
    <section className="relationship-explorer">
      <div className="relationship-toolbar">
        <div>
          <h2>{mode === 'taste-map' ? 'Zevk Haritası' : 'İlişki Keşfi'}</h2>
          <p>
            {mode === 'taste-map'
              ? 'Merkezden uzaklık kişisel uyumu, çizgiler içerikler arasındaki ilişkileri gösterir.'
              : 'Bir kaynak yapım seç; bağlantı türü, kanıtı ve kişisel uyumunu ayrı incele.'}
          </p>
        </div>
        <button className="btn btn-primary" type="button" onClick={handleRefresh} disabled={loading}>
          {loading ? 'Harita hazırlanıyor…' : 'Haritayı Güncelle'}
        </button>
      </div>

      <div className="relationship-filters">
        <label>
          İçerik türü
          <select value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value as MediaFilter)}>
            <option value="all">Film + dizi</option>
            <option value="movie">Sadece film</option>
            <option value="tv">Sadece dizi</option>
          </select>
        </label>

        {mode === 'relationships' && (
          <label>
            Kaynak yapım
            <select
              value={sourceKey}
              onChange={(event) => {
                setSourceKey(event.target.value);
                setSelectedNode(null);
              }}
            >
              <option value="">Kaynak seç…</option>
              {sourceOptions.map((item) => (
                <option key={relationshipNodeKey(item)} value={relationshipNodeKey(item)}>
                  {item.title || item.name || 'Başlıksız'}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          İlişki türü
          <select value={relationFilter} onChange={(event) => setRelationFilter(event.target.value as RelationFilter)}>
            <option value="all">Tüm ilişkiler</option>
            <option value="semantic">Anlamsal benzerlik</option>
            <option value="person">Kişi bağlantısı</option>
            <option value="universe">Seri / evren</option>
            {mode === 'taste-map' && <option value="personal">Kişisel uyum</option>}
          </select>
        </label>
      </div>

      {error && <div className="relationship-message" role="status">{error}</div>}

      <div className="relationship-layout">
        <div className="relationship-graph" ref={containerRef}>
          {graphData && graphData.nodes.length > 0 ? (
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
                return `${getRelationshipTypeLabel(link.type)} · ${link.score}/100 · Güven ${link.confidence}/100\n${link.evidence.join('\n')}`;
              }}
              linkDirectionalParticles={1}
              linkDirectionalParticleWidth={1.5}
              cooldownTicks={100}
              d3VelocityDecay={0.3}
              onEngineStop={() => graphRef.current?.pauseAnimation?.()}
            />
          ) : (
            <div className="relationship-empty">
              <div className="relationship-empty-icon">◎</div>
              <h3>
                {mode === 'relationships' && !sourceKey
                  ? 'Kaynak yapım seçilmedi'
                  : 'Harita henüz oluşturulmadı'}
              </h3>
              <p>
                {mode === 'relationships' && !sourceKey
                  ? 'İlişkileri keşfetmek için yukarıdaki menüden bir kaynak yapım seçin veya “Haritayı Güncelle” düğmesine basın.'
                  : 'Mevcut yerel aday havuzunu ve kişisel profilini kullanmak için “Haritayı Güncelle” düğmesine bas.'}
              </p>
            </div>
          )}
        </div>

        <aside className="relationship-details">
          <h3>{selectedNode?.title || 'Düğüm ayrıntıları'}</h3>
          {selectedNode ? (
            <>
              <p className="relationship-score">Kişisel uyum: <strong>{selectedNode.personalScore}/100</strong></p>
              <p className="relationship-muted">
                {selectedNode.kind === 'saved' ? `Listendeki durum: ${selectedNode.status || 'kayıtlı'}` :
                  selectedNode.kind === 'profile' ? 'Kullanıcı profili' :
                  selectedNode.kind === 'source' ? 'Seçilmiş kaynak yapım' : 'Keşif adayı'}
              </p>
              {selectedLinks.map((link, index) => (
                <div className="relationship-evidence" key={`${link.type}-${index}`}>
                  <strong>{getRelationshipTypeLabel(link.type)} · {link.score}/100</strong>
                  <span>Güven: {link.confidence}/100</span>
                  <ul>{link.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>
                </div>
              ))}
              {selectedItem && onOpenDetails && selectedNode.mediaType !== 'profile' && (
                <button className="btn" type="button" onClick={() => onOpenDetails(selectedItem)}>
                  İçerik ayrıntısını aç
                </button>
              )}
              {selectedItem && onQuickSave && selectedNode.kind === 'candidate' && (
                <button className="btn btn-primary" type="button" onClick={() => onQuickSave(selectedItem)}>
                  Listeye ekle
                </button>
              )}
            </>
          ) : (
            <p className="relationship-muted">Haritadaki bir düğüme tıklayarak puanını ve bağlantı kanıtlarını incele.</p>
          )}
          <div className="relationship-legend">
            <span><i className="legend-dot" style={{ background: '#5eead4' }} /> Kullanıcı profili</span>
            <span><i className="legend-dot" style={{ background: '#38bdf8' }} /> Kayıtlı yapım</span>
            <span><i className="legend-dot" style={{ background: '#4ade80' }} /> Yüksek kişisel uyum</span>
            <span><i className="legend-line" style={{ background: '#38bdf8' }} /> Anlamsal</span>
            <span><i className="legend-line" style={{ background: '#a78bfa' }} /> Kişi</span>
            <span><i className="legend-line" style={{ background: '#4ade80' }} /> Seri / evren</span>
          </div>
        </aside>
      </div>
    </section>
  );
};
