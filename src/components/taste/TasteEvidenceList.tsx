// ===========================================================================
// CineTrack — Kanıt Listesi Bileşeni
// Olumlu / olumsuz / belirsiz içerikler
// ===========================================================================

import React from "react";
import type { EvidenceItem } from "../../core/taste/profile-explainer";

interface TasteEvidenceListProps {
  positiveEvidence: EvidenceItem[];
  negativeEvidence: EvidenceItem[];
  neutralEvidence: EvidenceItem[];
}

export function TasteEvidenceList({
  positiveEvidence,
  negativeEvidence,
  neutralEvidence,
}: TasteEvidenceListProps) {
  const hasAnyEvidence =
    positiveEvidence.length > 0 ||
    negativeEvidence.length > 0 ||
    neutralEvidence.length > 0;

  if (!hasAnyEvidence) {
    return (
      <p className="evidence-list--empty">
        Henüz yeterli kanıt yok. Daha fazla içerik puanladıkça bu alan dolacak.
      </p>
    );
  }

  return (
    <div className="evidence-list">
      {/* Olumlu kanıt */}
      {positiveEvidence.length > 0 && (
        <section className="evidence-list__section evidence-list__section--positive">
          <h4 className="evidence-list__heading" id="evidence-positive">
            Olumlu Kanıtlar
          </h4>
          <ul aria-labelledby="evidence-positive">
            {positiveEvidence.map((item) => (
              <EvidenceRow key={item.contentId} item={item} />
            ))}
          </ul>
        </section>
      )}

      {/* Olumsuz kanıt */}
      {negativeEvidence.length > 0 && (
        <section className="evidence-list__section evidence-list__section--negative">
          <h4 className="evidence-list__heading" id="evidence-negative">
            Olumsuz Kanıtlar
          </h4>
          <ul aria-labelledby="evidence-negative">
            {negativeEvidence.map((item) => (
              <EvidenceRow key={item.contentId} item={item} />
            ))}
          </ul>
        </section>
      )}

      {/* Belirsiz kanıt */}
      {neutralEvidence.length > 0 && (
        <section className="evidence-list__section evidence-list__section--neutral">
          <h4 className="evidence-list__heading" id="evidence-neutral">
            Belirsiz Kanıtlar
          </h4>
          <ul aria-labelledby="evidence-neutral">
            {neutralEvidence.map((item) => (
              <EvidenceRow key={item.contentId} item={item} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface EvidenceRowProps {
  item: EvidenceItem;
}

function EvidenceRow({ item }: EvidenceRowProps) {
  const directionIcon =
    item.direction === "positive" ? "↑" : item.direction === "negative" ? "↓" : "→";
  const contributionPct = Math.round(item.contribution * 100);

  return (
    <li className={`evidence-row evidence-row--${item.direction}`}>
      <span className="evidence-row__icon" aria-hidden="true">
        {directionIcon}
      </span>
      <span className="evidence-row__content-id">{item.contentId}</span>
      <span
        className="evidence-row__contribution"
        title={`Katkı: ${contributionPct}%`}
      >
        {contributionPct}%
      </span>
      <span
        className="evidence-row__confidence"
        title={`Güven: ${Math.round(item.confidence * 100)}%`}
      >
        {Math.round(item.confidence * 100)}%
      </span>
    </li>
  );
}
