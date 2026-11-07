// ===========================================================================
// Cinethos Taste Engine — Evidence Ledger (v1.0)
// posMass/negMass/uncertainMass ayrımı; idempotency; katkı geri çekme (TP-015)
// ===========================================================================

import type { TasteEvent } from "./types.ts";
import { computeBehaviorSignal } from "./behavior-signals.ts";

export interface MetricEvidence {
  contentId: string;
  eventId: string;
  metricId: string;
  contribution: number;     // C_im = R_i × F'_im × Q_im × T_i × G_im
  baseWeight: number;       // W_im = F'_im × Q_im × T_i × G_im (signal'siz ağırlık — nötr için)
  featureStrength: number;  // F'_im (0-100 normalize)
  confidence: number;       // Q_im (0-1)
  behaviorSignal: number;   // R_i ([-1, +1])
  timeWeight: number;       // T_i
  groupDamping: number;     // G_im
  direction: "positive" | "negative" | "neutral";
  recordedAt: string;
}

export interface MetricMasses {
  posMass: number;
  negMass: number;
  uncertainMass: number;
  evidenceMass: number;     // D_m = Σ w_im (nötr dahil — KRİTİK KURAL)
  evidenceCount: number;
  topPositiveContentIds: string[];
  topNegativeContentIds: string[];
}

export class EvidenceLedger {
  private evidence: Map<string, MetricEvidence[]> = new Map(); // metricId -> evidence[]
  private processedKeys: Set<string> = new Set();

  /**
   * Olay ekle (idempotent — TP-005)
   * Idempotency anahtarı eventId+metricId: aynı olay her metrik için bir kez sayılır.
   */
  addEvent(
    event: TasteEvent,
    metricId: string,
    featureStrength: number,
    confidence: number,
    timeWeight: number,
    groupDamping: number
  ): void {
    const idempotencyKey = `${event.eventId}::${metricId}`;
    if (this.processedKeys.has(idempotencyKey)) {
      return;
    }

    const signalResult = this.extractSignal(event);
    if (!signalResult.isEvidence) {
      return; // kanıt değil (niyet, dışlama vb.)
    }

    const contribution =
      signalResult.signal *
      (featureStrength / 100) *
      confidence *
      timeWeight *
      groupDamping;

    // baseWeight: signal'sız ağırlık — nötr kanıtın paydaya girmesi için (TP-015)
    // D_m = Σ baseWeight_i (nötr dahil gerçek ağırlık toplamı)
    const baseWeight = (featureStrength / 100) * confidence * timeWeight * groupDamping;

    const evidence: MetricEvidence = {
      contentId: event.contentId,
      eventId: event.eventId,
      metricId,
      contribution,
      baseWeight,
      featureStrength,
      confidence,
      behaviorSignal: signalResult.signal,
      timeWeight,
      groupDamping,
      direction: contribution > 0 ? "positive" : contribution < 0 ? "negative" : "neutral",
      recordedAt: event.recordedAt,
    };

    if (!this.evidence.has(metricId)) {
      this.evidence.set(metricId, []);
    }
    this.evidence.get(metricId)!.push(evidence);
    this.processedKeys.add(idempotencyKey);
  }

  /**
   * İçeriğin tüm katkılarını geri çek (puan değişimi — TP-005)
   * Olay ≠ kanıt: aynı içeriğin puan değişimi eski katkıyı geri çeker, kanıt sayısı artmaz.
   */
  removeContributions(contentId: string): void {
    for (const [metricId, evidences] of this.evidence.entries()) {
      const filtered = evidences.filter((e) => e.contentId !== contentId);
      this.evidence.set(metricId, filtered);
    }
    // Artık o içerik için işlenmiş katkıları geri çekiyoruz; yeni olay yeni eventId ile gelecek.
  }

  /**
   * Metrik kütlelerini hesapla (TP-015)
   * KRİTİK: D_m = Σ w_im — nötr kanıt paydada kalır, yalnızca posMass+negMass kullanan
   * formül YASAK.
   */
  computeMasses(metricId: string): MetricMasses {
    const evidences = this.evidence.get(metricId) ?? [];

    let posMass = 0;
    let negMass = 0;
    let uncertainMass = 0;
    let evidenceMass = 0;

    const positiveContributions: Array<{ contentId: string; contribution: number }> = [];
    const negativeContributions: Array<{ contentId: string; contribution: number }> = [];

    for (const e of evidences) {
      const weight = Math.abs(e.contribution);
      evidenceMass += e.baseWeight; // D_m = Σ baseWeight (nötr dahil — KRİTİK KURAL)

      if (e.contribution > 0) {
        posMass += e.contribution;
        positiveContributions.push({ contentId: e.contentId, contribution: e.contribution });
      } else if (e.contribution < 0) {
        negMass += Math.abs(e.contribution);
        negativeContributions.push({ contentId: e.contentId, contribution: e.contribution });
      } else {
        // Nötr kanıt paydada kalır (KRİTİK KURAL — TP-015)
        // contribution=0 ama baseWeight > 0 → evidenceMass'a katkıda bulunur
        uncertainMass += e.baseWeight;
      }
    }

    // En çok katkı veren 3 içerik
    positiveContributions.sort((a, b) => b.contribution - a.contribution);
    negativeContributions.sort((a, b) => a.contribution - b.contribution);

    return {
      posMass,
      negMass,
      uncertainMass,
      evidenceMass,
      evidenceCount: evidences.length,
      topPositiveContentIds: positiveContributions.slice(0, 3).map((c) => c.contentId),
      topNegativeContentIds: negativeContributions.slice(0, 3).map((c) => c.contentId),
    };
  }

  /** Tüm metriklerin kütlelerini döndür */
  computeAllMasses(): Map<string, MetricMasses> {
    const result = new Map<string, MetricMasses>();
    for (const metricId of this.evidence.keys()) {
      result.set(metricId, this.computeMasses(metricId));
    }
    return result;
  }

  /** Kayıtlı metrik ID listesi */
  getMetricIds(): string[] {
    return Array.from(this.evidence.keys());
  }

  private extractSignal(event: TasteEvent): { signal: number; isEvidence: boolean } {
    if (event.eventType === "rating_changed") {
      const rating = event.payload.newValue as number;
      const source = event.payload.ratingSource ?? "numeric";
      const result = computeBehaviorSignal({ type: "rating", value: rating, source });
      return { signal: result.signal, isEvidence: result.isEvidence };
    }

    if (event.eventType === "status_changed") {
      const status = event.payload.newValue as string;
      if (status === "watchlist") {
        const result = computeBehaviorSignal({ type: "intent", value: "watchlist" });
        return { signal: result.signal, isEvidence: result.isEvidence };
      }
      if (status === "watching") {
        const result = computeBehaviorSignal({ type: "intent", value: "watching" });
        return { signal: result.signal, isEvidence: result.isEvidence };
      }
      if (status === "completed") {
        const result = computeBehaviorSignal({ type: "watched_no_rating" });
        return { signal: result.signal, isEvidence: result.isEvidence };
      }
    }

    if (event.eventType === "content_hidden") {
      const result = computeBehaviorSignal({ type: "hidden" });
      return { signal: result.signal, isEvidence: result.isEvidence };
    }

    if (event.eventType === "content_disliked") {
      const result = computeBehaviorSignal({ type: "abandoned", reason: "disliked" });
      return { signal: result.signal, isEvidence: result.isEvidence };
    }

    return { signal: 0, isEvidence: false };
  }
}
