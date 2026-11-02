// ===========================================================================
// CineTrack — "Sinema Kimliğim" Ana Ekranı
// Kullanıcının taste profilini kategori bazında gösterir.
// ===========================================================================

import React, { useState } from "react";
import { useTasteProfile } from "../../hooks/useTasteProfile";
import { TasteCategoryDetail } from "./TasteCategoryDetail";
import { getMetricsByCategory } from "../../core/taste/taxonomy";

const CATEGORIES = [
  { id: "genre",     label: "Tür" },
  { id: "mood",      label: "Atmosfer" },
  { id: "narrative", label: "Anlatı" },
  { id: "concept",   label: "Tema" },
  { id: "character", label: "Karakter" },
  { id: "style",     label: "Stil" },
  { id: "setting",   label: "Ortam" },
  { id: "origin",    label: "Köken" },
  { id: "format",    label: "Format" },
];

export function TasteProfileDashboard() {
  const { profile, status, error, reload } = useTasteProfile();
  const [activeCategory, setActiveCategory] = useState<string>("genre");

  if (status === "loading") {
    return (
      <div className="taste-dashboard taste-dashboard--loading" role="status" aria-busy="true">
        <p>Sinema kimliğin yükleniyor…</p>
      </div>
    );
  }

  if (status === "error" || error) {
    return (
      <div className="taste-dashboard taste-dashboard--error" role="alert">
        <p>Profil yüklenemedi: {error}</p>
        <button type="button" onClick={() => void reload()}>
          Yeniden Dene
        </button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="taste-dashboard taste-dashboard--empty">
        <p>Henüz bir sinema kimliği oluşturulmadı.</p>
      </div>
    );
  }

  const activeMetrics = getMetricsByCategory(activeCategory);
  const categoryMetrics = activeMetrics
    .filter((m) => m.scoringEnabled)
    .map((m) => ({
      definition: m,
      profileMetric: profile.metrics[m.id] ?? null,
    }));

  return (
    <div className="taste-dashboard">
      <header className="taste-dashboard__header">
        <h1>Sinema Kimliğim</h1>
        <p className="taste-dashboard__subtitle">
          Algoritmik zevk profilin — her metrik kanıta dayanıyor
        </p>
      </header>

      {/* Kategori sekmeler */}
      <nav className="taste-dashboard__tabs" role="tablist" aria-label="Zevk kategorileri">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            role="tab"
            aria-selected={activeCategory === cat.id}
            aria-controls={`panel-${cat.id}`}
            id={`tab-${cat.id}`}
            type="button"
            className={`taste-tab ${activeCategory === cat.id ? "taste-tab--active" : ""}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </nav>

      {/* Aktif kategori paneli */}
      <section
        id={`panel-${activeCategory}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeCategory}`}
        className="taste-dashboard__panel"
      >
        <TasteCategoryDetail
          categoryId={activeCategory}
          metrics={categoryMetrics}
          profile={profile}
        />
      </section>
    </div>
  );
}
