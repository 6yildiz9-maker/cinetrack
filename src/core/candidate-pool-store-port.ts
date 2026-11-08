import type { PersistentCandidatePoolData } from './cinetrack-core.ts';

export interface CandidatePoolStorePort {
  hydrateDiscoveryHistory(profileId: string): Promise<unknown>;
  hydrateCandidatePools(profileId: string): Promise<unknown>;
  loadPool(profileId: string, mediaType: 'movie' | 'tv'): PersistentCandidatePoolData;
  savePool(profileId: string, data: PersistentCandidatePoolData): void;
}

let activePort: CandidatePoolStorePort | null = null;

export function registerCandidatePoolStorePort(port: CandidatePoolStorePort): void {
  activePort = port;
}

export function getCandidatePoolStorePort(): CandidatePoolStorePort | null {
  return activePort;
}
