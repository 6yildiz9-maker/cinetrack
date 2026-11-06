import React from 'react';
import type {
  RelationshipEvidenceDetail,
  RelationshipGraphLink,
  RelationshipGraphNode,
} from '../core/relationship-explorer.ts';
import { getRelationshipTypeLabel } from '../core/relationship-wordlists.ts';
import type { PoolCandidateItem, SavedItem } from '../core/cinetrack-core.ts';

interface RelationshipDetailsPanelProps {
  selectedNode: RelationshipGraphNode | null;
  selectedLinks: RelationshipGraphLink[];
  nodeTitleById: Map<string, string>;
  selectedItem?: PoolCandidateItem | SavedItem | null;
  onOpenDetails?: (item: PoolCandidateItem | SavedItem) => void;
  onQuickSave?: (item: PoolCandidateItem | SavedItem) => void;
}

function linkEndpointId(endpoint: any): string {
  if (!endpoint) return '';
  if (typeof endpoint === 'string') return endpoint;
  return String(endpoint.id || '');
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

export const RelationshipDetailsPanel: React.FC<RelationshipDetailsPanelProps> = ({
  selectedNode,
  selectedLinks,
  nodeTitleById,
  selectedItem,
  onOpenDetails,
  onQuickSave,
}) => {
  return (
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

            const details: RelationshipEvidenceDetail[] = link.relationshipDetails?.length
              ? link.relationshipDetails
              : [
                  {
                    type: link.type === 'personal' ? 'semantic' : link.type,
                    score: link.score,
                    confidence: link.confidence,
                    evidence: Array.isArray(link.evidence) ? link.evidence : [],
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
                {Boolean((detail as any).breakdown) && (
                  <div className="relationship-breakdown-tags" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '4px 0 6px 0', fontSize: '11px', color: '#94a3b8' }}>
                    {(detail as any).breakdown.vectorContribution !== undefined && (
                      <span className="breakdown-tag" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#93c5fd', padding: '1px 6px', borderRadius: '4px' }}>
                        %{(detail as any).breakdown.vectorContribution} Vektör
                      </span>
                    )}
                    {(detail as any).breakdown.genreContribution !== undefined && (
                      <span className="breakdown-tag" style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#d8b4fe', padding: '1px 6px', borderRadius: '4px' }}>
                        %{(detail as any).breakdown.genreContribution} Tür
                      </span>
                    )}
                    {(detail as any).breakdown.personContribution !== undefined && (
                      <span className="breakdown-tag" style={{ background: 'rgba(236, 72, 153, 0.15)', color: '#f472b6', padding: '1px 6px', borderRadius: '4px' }}>
                        %{(detail as any).breakdown.personContribution} Kadro
                      </span>
                    )}
                    {(detail as any).breakdown.toneContribution !== undefined && (
                      <span className="breakdown-tag" style={{ background: 'rgba(234, 179, 8, 0.15)', color: '#fde047', padding: '1px 6px', borderRadius: '4px' }}>
                        %{(detail as any).breakdown.toneContribution} Ton
                      </span>
                    )}
                    {(detail as any).breakdown.seriesContribution !== undefined && (
                      <span className="breakdown-tag" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#86efac', padding: '1px 6px', borderRadius: '4px' }}>
                        %{(detail as any).breakdown.seriesContribution} Evren
                      </span>
                    )}
                    {(detail as any).breakdown.contrastContribution !== undefined && (
                      <span className="breakdown-tag" style={{ background: 'rgba(249, 115, 22, 0.15)', color: '#fdba74', padding: '1px 6px', borderRadius: '4px' }}>
                        %{(detail as any).breakdown.contrastContribution} Karşıtlık
                      </span>
                    )}
                  </div>
                )}
                <ul>
                  {(Array.isArray(detail.evidence) ? detail.evidence : []).map((evidence) => (
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
          <i className="legend-line legend-line-atmosphere" /> Atmosferik yakınlık
        </span>
        <span>
          <i className="legend-line legend-line-contrast" /> Karşıt ton
        </span>
        <span>
          <i className="legend-line legend-line-person" /> Kişi bağlantısı
        </span>
        <span>
          <i className="legend-line legend-line-universe" /> Seri / evren
        </span>
      </div>
    </aside>
  );
};
