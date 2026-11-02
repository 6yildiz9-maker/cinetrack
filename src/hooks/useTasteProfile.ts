// ===========================================================================
// CineTrack Taste Engine — useTasteProfile Hook (v1.0)
// Profil verisi + loading/error state yönetimi
// ===========================================================================

import { useState, useEffect, useCallback } from "react";
import type { TasteProfile } from "../core/taste/types.ts";
import {
  fetchTasteProfile,
  postManualOverride,
  deleteManualOverride,
  subscribeTasteProfileUpdated,
} from "../services/taste-api.ts";
import type { OverrideRequest } from "../services/taste-api.ts";

export type TasteProfileStatus = "idle" | "loading" | "success" | "error";

export interface UseTasteProfileResult {
  profile: TasteProfile | null;
  status: TasteProfileStatus;
  error: string | null;
  /** Profili sunucudan yeniden yükle */
  reload: () => Promise<void>;
  /** Manuel metrik kontrolü uygula (TP-028) */
  applyOverride: (req: OverrideRequest) => Promise<void>;
  /** Manuel kontrolü geri al */
  removeOverride: (metricId: string) => Promise<void>;
}

/**
 * Taste profilini yükleyen, arka plan worker tamamlandığında canlı güncelleyen
 * ve manuel kontrol işlemlerini yöneten React hook.
 *
 * Kullanım:
 *   const { profile, status, error, reload, applyOverride, removeOverride } = useTasteProfile();
 */
export function useTasteProfile(): UseTasteProfileResult {
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [status, setStatus] = useState<TasteProfileStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const loadFromServer = useCallback(async (silent = false) => {
    if (!silent) {
      setStatus("loading");
    }
    setError(null);
    try {
      const data = await fetchTasteProfile();
      setProfile(data);
      setStatus("success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Profil yüklenemedi";
      setError(msg);
      if (!silent) {
        setStatus("error");
      }
    }
  }, []);

  const reload = useCallback(async () => {
    await loadFromServer(false);
  }, [loadFromServer]);

  // İlk yükleme
  useEffect(() => {
    void loadFromServer(false);
  }, [loadFromServer]);

  // Arka planda profil yeniden hesaplandığında veya override değiştiğinde canlı güncelle (Sorun 2 — Adım 3)
  useEffect(() => {
    return subscribeTasteProfileUpdated(() => {
      void loadFromServer(true);
    });
  }, [loadFromServer]);

  /** Manuel kontrol uygula */
  const applyOverride = useCallback(
    async (req: OverrideRequest) => {
      try {
        await postManualOverride(req);
        // Profili yenile (sunucudan güncel veriyi al)
        await reload();
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Manuel kontrol uygulanamadı";
        setError(msg);
      }
    },
    [reload]
  );

  /** Manuel kontrolü geri al */
  const removeOverride = useCallback(
    async (metricId: string) => {
      try {
        await deleteManualOverride(metricId);
        // Profili yenile
        await reload();
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Override kaldırılamadı";
        setError(msg);
      }
    },
    [reload]
  );

  return {
    profile,
    status,
    error,
    reload,
    applyOverride,
    removeOverride,
  };
}
