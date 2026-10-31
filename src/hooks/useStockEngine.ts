import { useEffect, useState } from 'react';
import {
  initStockEngine,
  scheduleStockReplenishment,
  subscribeStockState,
  STOCK_REPLENISH_THRESHOLD,
  type StockState,
} from '../services/stock-engine';
import { initSeriesService } from '../services/series-service';
import { loadSurfacedKeys } from '../services/storage-idb';

export function useStockEngine(profileId: string): StockState {
  const [stockState, setStockState] = useState<StockState>({
    movies: [],
    tv: [],
    moviesCount: 0,
    tvCount: 0,
    isLoading: true,
    isReplenishing: false,
    lastUpdated: '',
  });

  useEffect(() => {
    let active = true;

    void Promise.all([initSeriesService(), loadSurfacedKeys()])
      .then(() => {
        if (!active) return;
        return initStockEngine(profileId);
      })
      .catch((err) => {
        console.warn('[useStockEngine] Initialization error:', err);
      });

    const unsubscribe = subscribeStockState((nextState) => {
      if (!active) return;
      setStockState(nextState);

      // Autonomous background threshold listener (Aşama 4: Adım 13):
      // Whenever movie or TV stock drops below 250, replenish back to 500 automatically.
      if (
        !nextState.isLoading &&
        !nextState.isReplenishing &&
        (nextState.moviesCount < STOCK_REPLENISH_THRESHOLD ||
          nextState.tvCount < STOCK_REPLENISH_THRESHOLD)
      ) {
        scheduleStockReplenishment(profileId, 400);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [profileId]);

  return stockState;
}
