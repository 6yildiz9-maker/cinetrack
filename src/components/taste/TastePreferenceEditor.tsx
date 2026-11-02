// ===========================================================================
// CineTrack — Tercih Editörü Bileşeni
// Otomatik / Güçlendir / Azalt / Sabitle / Sıfırla / İlgisiz (TP-028)
// ===========================================================================

import React, { useState } from "react";
import type { OverrideRequest } from "../../services/taste-api";

type OverrideMode = "replace" | "boost" | "suppress";

interface ManualOverride {
  value: number;
  mode: OverrideMode;
}

interface TastePreferenceEditorProps {
  metricId: string;
  currentOverride?: ManualOverride;
  onOverride: (req: OverrideRequest) => Promise<void>;
  onRemoveOverride: (metricId: string) => Promise<void>;
}

const MODE_LABELS: Record<OverrideMode, string> = {
  replace: "Sabitle",
  boost:   "Güçlendir",
  suppress: "Azalt",
};

const MODE_DESCRIPTIONS: Record<OverrideMode, string> = {
  replace:  "Algoritmanın hesabını yok say, bu değeri kullan",
  boost:    "Algoritma değerini yukarı yönde güçlendir",
  suppress: "Algoritma değerini aşağı yönde bastır",
};

export function TastePreferenceEditor({
  metricId,
  currentOverride,
  onOverride,
  onRemoveOverride,
}: TastePreferenceEditorProps) {
  const [selectedMode, setSelectedMode] = useState<OverrideMode>(
    currentOverride?.mode ?? "replace"
  );
  const [value, setValue] = useState<number>(currentOverride?.value ?? 0);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const handleApply = async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      await onOverride({ metricId, value, mode: selectedMode });
      setStatusMsg("Kontrol uygulandı.");
    } catch {
      setStatusMsg("Uygulama başarısız oldu.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      await onRemoveOverride(metricId);
      setStatusMsg("Otomatik moda dönüldü.");
    } catch {
      setStatusMsg("Sıfırlama başarısız oldu.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="preference-editor" role="group" aria-label="Tercih kontrolü">
      <h4 className="preference-editor__title">Tercihini Düzenle</h4>

      {/* Manuel kontrol mevcut ise bildir */}
      {currentOverride && (
        <p className="preference-editor__current" role="status">
          Mevcut kontrol:{" "}
          <strong>{MODE_LABELS[currentOverride.mode]}</strong> ({currentOverride.value})
        </p>
      )}

      {/* Mod seçimi */}
      <fieldset className="preference-editor__modes">
        <legend className="preference-editor__legend">Kontrol Türü</legend>
        {(["replace", "boost", "suppress"] as OverrideMode[]).map((mode) => (
          <label key={mode} className="preference-editor__mode-option">
            <input
              type="radio"
              name={`mode-${metricId}`}
              value={mode}
              checked={selectedMode === mode}
              onChange={() => setSelectedMode(mode)}
              aria-describedby={`mode-desc-${mode}`}
            />
            <span className="preference-editor__mode-label">{MODE_LABELS[mode]}</span>
            <span
              id={`mode-desc-${mode}`}
              className="preference-editor__mode-desc"
            >
              {MODE_DESCRIPTIONS[mode]}
            </span>
          </label>
        ))}
      </fieldset>

      {/* Değer seçici (-100...+100) */}
      <div className="preference-editor__value">
        <label htmlFor={`value-${metricId}`}>Değer (-100 … +100)</label>
        <input
          id={`value-${metricId}`}
          type="range"
          min={-100}
          max={100}
          step={5}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-valuemin={-100}
          aria-valuemax={100}
          aria-valuenow={value}
          aria-label="Tercih değeri"
        />
        <output htmlFor={`value-${metricId}`} className="preference-editor__value-output">
          {value}
        </output>
      </div>

      {/* Eylem butonları */}
      <div className="preference-editor__actions">
        <button
          type="button"
          className="preference-editor__btn preference-editor__btn--apply"
          onClick={() => void handleApply()}
          disabled={saving}
        >
          {saving ? "Uygulanıyor…" : "Uygula"}
        </button>

        {currentOverride && (
          <button
            type="button"
            className="preference-editor__btn preference-editor__btn--reset"
            onClick={() => void handleReset()}
            disabled={saving}
          >
            Sıfırla (Otomatik)
          </button>
        )}
      </div>

      {/* Durum mesajı */}
      {statusMsg && (
        <p className="preference-editor__status" role="status" aria-live="polite">
          {statusMsg}
        </p>
      )}
    </div>
  );
}
