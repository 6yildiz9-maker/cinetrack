// ===========================================================================
// Cinethos — Derin Sinema Manuel Tercih Kontrol Paneli (TP-028)
// Otomatik / Güçlendir / Azalt / İlgisiz + Hassas Sabitleme (Replace)
// ===========================================================================

import React, { useEffect, useState } from "react";
import {
  Ban,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import type { ManualOverrideMode, TasteMetric } from "../../core/taste/types.ts";
import {
  deleteManualOverride,
  postManualOverride,
  type OverrideRequest,
} from "../../services/taste-api.ts";

type QuickMode = "auto" | "boost" | "suppress" | "exclude" | "replace";

export interface TastePreferenceEditorProps {
  metricId: string;
  currentValue?: number;
  currentOverride?: TasteMetric["manualOverride"];
  onOverride?: (req: OverrideRequest) => Promise<void>;
  onRemoveOverride?: (metricId: string) => Promise<void>;
}

const DEFAULT_BOOST_DELTA = 35;
const DEFAULT_SUPPRESS_STRENGTH = 60;

export const TastePreferenceEditor: React.FC<TastePreferenceEditorProps> = ({
  metricId,
  currentValue = 0,
  currentOverride,
  onOverride,
  onRemoveOverride,
}) => {
  const activeMode: QuickMode = currentOverride?.mode ?? "auto";
  const [mode, setMode] = useState<QuickMode>(activeMode);
  const [showFineSlider, setShowFineSlider] = useState<boolean>(
    currentOverride?.mode === "replace"
  );
  const [fineValue, setFineValue] = useState<number>(
    currentOverride?.mode === "replace"
      ? currentOverride.value
      : Math.max(-100, Math.min(100, Math.round(currentValue)))
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    setMode(currentOverride?.mode ?? "auto");
    if (currentOverride?.mode === "replace") {
      setShowFineSlider(true);
      setFineValue(currentOverride.value);
    } else if (!currentOverride) {
      setFineValue(Math.max(-100, Math.min(100, Math.round(currentValue))));
    }
  }, [currentOverride, currentValue]);

  const applyRequest = async (req: OverrideRequest, successText: string) => {
    setSaving(true);
    setStatusMessage(null);
    try {
      if (onOverride) {
        await onOverride(req);
      } else {
        await postManualOverride(req);
      }
      setMode(req.mode);
      setStatusMessage(successText);
    } catch {
      setStatusMessage("Tercih kaydedilirken bir hata oluştu.");
    } finally {
      setSaving(false);
    }
  };

  const resetToAuto = async () => {
    setSaving(true);
    setStatusMessage(null);
    try {
      if (onRemoveOverride) {
        await onRemoveOverride(metricId);
      } else {
        await deleteManualOverride(metricId);
      }
      setMode("auto");
      setShowFineSlider(false);
      setStatusMessage("Otomatik algoritmik hesaplamaya dönüldü.");
    } catch {
      setStatusMessage("Sıfırlama sırasında bir hata oluştu.");
    } finally {
      setSaving(false);
    }
  };

  const handleModeSelect = (nextMode: "auto" | "boost" | "suppress" | "exclude") => {
    if (saving) return;
    if (nextMode === "auto") {
      void resetToAuto();
      return;
    }
    if (nextMode === "boost") {
      void applyRequest(
        { metricId, mode: "boost", value: DEFAULT_BOOST_DELTA },
        "Bu özellik önerilerde güçlendirildi."
      );
      return;
    }
    if (nextMode === "suppress") {
      void applyRequest(
        { metricId, mode: "suppress", value: DEFAULT_SUPPRESS_STRENGTH },
        "Bu özelliğin öneri ağırlığı azaltıldı."
      );
      return;
    }
    void applyRequest(
      { metricId, mode: "exclude", value: 0 },
      "Bu özellik zevk profilinden hariç tutuldu."
    );
  };

  const handleFineReplaceApply = () => {
    if (saving) return;
    const clampedMode: ManualOverrideMode = "replace";
    void applyRequest(
      { metricId, mode: clampedMode, value: fineValue },
      `Eğilim skoru manuel olarak ${fineValue > 0 ? `+${fineValue}` : fineValue} değerine sabitlendi.`
    );
  };

  return (
    <div
      className="bg-cinema-surface/70 border border-cinema-border rounded-2xl p-5"
      role="group"
      aria-label="Manuel Profil Kontrolü"
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-cinema-textPrimary">
          <Settings2 className="w-4 h-4 text-cinema-cyan shrink-0" />
          <span>Manuel Profil Kontrolü</span>
        </div>
        <button
          type="button"
          onClick={() => setShowFineSlider((prev) => !prev)}
          className="inline-flex items-center gap-1.5 text-xs text-cinema-textMuted hover:text-cinema-textPrimary transition-colors"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>{showFineSlider ? "Hassas Ayarı Gizle" : "Hassas Sabitle"}</span>
        </button>
      </div>

      <p className="text-xs text-cinema-textMuted mb-4 leading-relaxed">
        Algoritma geçmişinden otomatik çıkarım yapar; ancak önerileri anında yönlendirmek için kontrol her zaman sendedir.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <button
          type="button"
          disabled={saving}
          onClick={() => handleModeSelect("auto")}
          className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-medium transition-all disabled:opacity-50 ${
            mode === "auto"
              ? "bg-white/10 border-white/30 text-cinema-textPrimary"
              : "bg-cinema-bg/60 border-white/5 text-cinema-textMuted hover:border-white/15 hover:text-cinema-textPrimary"
          }`}
        >
          <RotateCcw className="w-4 h-4 mb-1.5" />
          <span>Otomatik</span>
        </button>

        <button
          type="button"
          disabled={saving}
          onClick={() => handleModeSelect("boost")}
          className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-medium transition-all disabled:opacity-50 ${
            mode === "boost"
              ? "bg-cinema-goldDim border-cinema-gold/60 text-cinema-gold shadow-glowGold"
              : "bg-cinema-bg/60 border-white/5 text-cinema-textMuted hover:border-white/15 hover:text-cinema-textPrimary"
          }`}
        >
          <ThumbsUp className="w-4 h-4 mb-1.5" />
          <span>Güçlendir</span>
        </button>

        <button
          type="button"
          disabled={saving}
          onClick={() => handleModeSelect("suppress")}
          className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-medium transition-all disabled:opacity-50 ${
            mode === "suppress"
              ? "bg-cinema-cyanDim border-cinema-cyan/50 text-cinema-cyan shadow-glowCyan"
              : "bg-cinema-bg/60 border-white/5 text-cinema-textMuted hover:border-white/15 hover:text-cinema-textPrimary"
          }`}
        >
          <ThumbsDown className="w-4 h-4 mb-1.5" />
          <span>Azalt</span>
        </button>

        <button
          type="button"
          disabled={saving}
          onClick={() => handleModeSelect("exclude")}
          className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-medium transition-all disabled:opacity-50 ${
            mode === "exclude"
              ? "bg-cinema-danger/15 border-cinema-danger/60 text-cinema-danger"
              : "bg-cinema-bg/60 border-white/5 text-cinema-textMuted hover:border-white/15 hover:text-cinema-textPrimary"
          }`}
        >
          <Ban className="w-4 h-4 mb-1.5" />
          <span>İlgisiz</span>
        </button>
      </div>

      {showFineSlider && (
        <div className="mt-4 pt-4 border-t border-white/10">
          <div className="flex items-center justify-between text-xs mb-2">
            <label htmlFor={`fine-override-${metricId}`} className="text-cinema-textMuted">
              Sabit Eğilim Değeri (-100 … +100)
            </label>
            <output
              htmlFor={`fine-override-${metricId}`}
              className="metric-value font-semibold text-cinema-gold"
            >
              {fineValue > 0 ? `+${fineValue}` : fineValue}
            </output>
          </div>
          <div className="flex items-center gap-3">
            <input
              id={`fine-override-${metricId}`}
              type="range"
              min={-100}
              max={100}
              step={5}
              value={fineValue}
              onChange={(e) => setFineValue(Number(e.target.value))}
              aria-label="Sabit eğilim skoru"
              className="w-full accent-cinema-gold cursor-pointer"
            />
            <button
              type="button"
              disabled={saving}
              onClick={handleFineReplaceApply}
              className="btn-primary text-xs px-3.5 py-2 shrink-0 disabled:opacity-50"
            >
              Sabitle
            </button>
          </div>
        </div>
      )}

      {mode !== "auto" && (
        <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between gap-2 text-xs">
          <span className="text-cinema-textMuted">
            Manuel ayar aktif ({mode === "boost" ? "Güçlendirildi" : mode === "suppress" ? "Azaltıldı" : mode === "exclude" ? "Hariç Tutuldu" : `Sabit: ${fineValue}`})
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => void resetToAuto()}
            className="text-cinema-gold hover:underline font-medium disabled:opacity-50"
          >
            Değişikliği Geri Al (Otomatiğe Dön)
          </button>
        </div>
      )}

      {statusMessage && (
        <p
          className="mt-2.5 text-xs text-cinema-cyan"
          role="status"
          aria-live="polite"
        >
          {statusMessage}
        </p>
      )}
    </div>
  );
};
