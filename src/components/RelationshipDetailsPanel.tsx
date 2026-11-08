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

function formatConfidenceTier(score: number): { label: string; badgeClass: string } {
  if (score >= 85) return { label: 'Yüksek Güven', badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' };
  if (score >= 65) return { label: 'Orta Güven', badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/40' };
  return { label: 'Temel Güven', badgeClass: 'bg-zinc-500/20 text-zinc-300 border border-zinc-500/40' };
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
                    confidenceScore: link.confidenceScore ?? Number((link.confidence / 100).toFixed(2)),
                    evidence: Array.isArray(link.evidence) ? link.evidence : [],
                    evidenceTypes: link.evidenceTypes,
                    features: link.features,
                  },
                ];

            return details.map((detail, detailIndex) => {
              const confPct = Math.round(
                detail.confidenceScore != null ? detail.confidenceScore * 100 : detail.confidence,
              );
              const tier = formatConfidenceTier(confPct);

              return (
                <div
                  className="relationship-evidence"
                  key={`${linkIndex}-${detail.type}-${detailIndex}`}
                >
                  {counterpartTitle && (
                    <span className="relationship-counterpart">
                      Bağlantı: {counterpartTitle}
                    </span>
                  )}
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <strong>
                      {getRelationshipTypeLabel(detail.type)} · {detail.score}/100
                    </strong>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-medium ${tier.badgeClass}`}>
                      %{confPct} {tier.label}
                    </span>
                  </div>

                  {/* Kanıt Türleri Etiketleri */}
                  {detail.evidenceTypes && detail.evidenceTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1 my-1">
                      {detail.evidenceTypes.map((et) => (
                        <span
                          key={et}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 font-mono"
                        >
                          {et === 'director'
                            ? '🎬 Yönetmen'
                            : et === 'writer'
                              ? '✍️ Senarist'
                              : et === 'actor'
                                ? '🎭 Oyuncu'
                                : et === 'universe'
                                  ? '🌌 Evren'
                                  : et === 'concept'
                                    ? '💡 Konsept'
                                    : et === 'keyword'
                                      ? '🏷️ Anahtar Kelime'
                                      : et === 'atmosphere'
                                        ? '🌫️ Atmosfer'
                                        : et === 'contrast'
                                          ? '⚡ Karşıtlık'
                                          : et}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Özellik Ayrımı (Features) */}
                  {detail.features && (
                    <div className="text-[11px] text-zinc-400 space-y-0.5 my-1.5">
                      {detail.features.matchedDirectors && detail.features.matchedDirectors.length > 0 && (
                        <div>
                          <span className="text-zinc-500">Ortak Yönetmen:</span>{' '}
                          <span className="text-zinc-200">{detail.features.matchedDirectors.join(', ')}</span>
                        </div>
                      )}
                      {detail.features.matchedWriters && detail.features.matchedWriters.length > 0 && (
                        <div>
                          <span className="text-zinc-500">Ortak Senarist:</span>{' '}
                          <span className="text-zinc-200">{detail.features.matchedWriters.join(', ')}</span>
                        </div>
                      )}
                      {detail.features.matchedActors && detail.features.matchedActors.length > 0 && (
                        <div>
                          <span className="text-zinc-500">Ortak Oyuncular:</span>{' '}
                          <span className="text-zinc-200">{detail.features.matchedActors.join(', ')}</span>
                        </div>
                      )}
                      {detail.features.universeName && (
                        <div>
                          <span className="text-zinc-500">Seri / Evren:</span>{' '}
                          <span className="text-emerald-300 font-medium">{detail.features.universeName}</span>
                        </div>
                      )}
                      {detail.features.matchedConcepts && detail.features.matchedConcepts.length > 0 && (
                        <div>
                          <span className="text-zinc-500">Tematik Konseptler:</span>{' '}
                          <span className="text-teal-300">{detail.features.matchedConcepts.join(', ')}</span>
                        </div>
                      )}
                      {detail.features.matchedKeywords && detail.features.matchedKeywords.length > 0 && (
                        <div>
                          <span className="text-zinc-500">TMDB Anahtar Kelimeleri:</span>{' '}
                          <span className="text-indigo-300">{detail.features.matchedKeywords.join(', ')}</span>
                        </div>
                      )}
                      {detail.features.atmosphereCluster && (
                        <div>
                          <span className="text-zinc-500">Atmosfer Kümesi:</span>{' '}
                          <span className="text-amber-300">{detail.features.atmosphereCluster}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Katkı Payı Dağılımı (Breakdown) */}
                  {detail.breakdown && (
                    <div className="flex flex-wrap gap-1.5 my-1.5 text-[11px] text-zinc-300">
                      {detail.breakdown.vectorContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">
                          %{detail.breakdown.vectorContribution} Vektör
                        </span>
                      )}
                      {detail.breakdown.conceptContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">
                          %{detail.breakdown.conceptContribution} Konsept
                        </span>
                      )}
                      {detail.breakdown.keywordContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                          %{detail.breakdown.keywordContribution} Kelime
                        </span>
                      )}
                      {detail.breakdown.genreContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300">
                          %{detail.breakdown.genreContribution} Tür
                        </span>
                      )}
                      {detail.breakdown.directorContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">
                          %{detail.breakdown.directorContribution} Yönetmen
                        </span>
                      )}
                      {detail.breakdown.writerContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300">
                          %{detail.breakdown.writerContribution} Senarist
                        </span>
                      )}
                      {detail.breakdown.actorContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-300">
                          %{detail.breakdown.actorContribution} Oyuncu
                        </span>
                      )}
                      {detail.breakdown.personContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-300">
                          %{detail.breakdown.personContribution} Kadro
                        </span>
                      )}
                      {detail.breakdown.universeContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                          %{detail.breakdown.universeContribution} Evren
                        </span>
                      )}
                      {detail.breakdown.toneContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                          %{detail.breakdown.toneContribution} Ton
                        </span>
                      )}
                      {detail.breakdown.seriesContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                          %{detail.breakdown.seriesContribution} Evren
                        </span>
                      )}
                      {detail.breakdown.contrastContribution !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-600/15 text-amber-300">
                          %{detail.breakdown.contrastContribution} Karşıtlık
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
              );
            });
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
          <i className="legend-line legend-line-semantic" /> Anlamsal / Konsept
        </span>
        <span>
          <i className="legend-line legend-line-atmosphere" /> Atmosferik yakınlık
        </span>
        <span>
          <i className="legend-line legend-line-contrast" /> Karşıt ton
        </span>
        <span>
          <i className="legend-line legend-line-person" /> Kişi (Yönetmen / Senarist / Oyuncu)
        </span>
        <span>
          <i className="legend-line legend-line-universe" /> Seri / Evren
        </span>
      </div>
    </aside>
  );
};
