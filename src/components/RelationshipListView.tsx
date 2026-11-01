import React from 'react';
import type {
  RelationshipGraphLink,
  RelationshipGraphNode,
} from '../core/relationship-explorer.ts';
import { getRelationshipTypeLabel } from '../core/relationship-wordlists.ts';
import { relationshipNodeKey } from '../core/relationship-explorer.ts';
import type { PoolCandidateItem, SavedItem } from '../core/cinetrack-core.ts';

interface RelationshipListViewProps {
  listNodes: Array<{
    node: RelationshipGraphNode;
    links: RelationshipGraphLink[];
    topLinkScore: number;
  }>;
  selectedNode: RelationshipGraphNode | null;
  setSelectedNode: (node: RelationshipGraphNode) => void;
  snapshotCandidates: PoolCandidateItem[];
  savedItems: SavedItem[];
  nodeTitleById: Map<string, string>;
  onOpenDetails?: (item: PoolCandidateItem | SavedItem) => void;
  onQuickSave?: (item: PoolCandidateItem | SavedItem) => void;
}

function linkEndpointId(endpoint: any): string {
  if (!endpoint) return '';
  if (typeof endpoint === 'string') return endpoint;
  return String(endpoint.id || '');
}

export const RelationshipListView: React.FC<RelationshipListViewProps> = ({
  listNodes,
  selectedNode,
  setSelectedNode,
  snapshotCandidates,
  savedItems,
  nodeTitleById,
  onOpenDetails,
  onQuickSave,
}) => {
  return (
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
                  <span className="relationship-list-badge is-score tabular-nums">
                    Uyum: {node.personalScore}/100
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
  );
};
