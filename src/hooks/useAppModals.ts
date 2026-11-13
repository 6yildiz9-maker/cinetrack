import { useState, useCallback } from 'react';

export interface AppModalsState {
  detailItem: any | null;
  setDetailItem: (item: any | null) => void;
  openDetail: (item: any) => void;
  closeDetail: () => void;

  quickSaveItem: any | null;
  setQuickSaveItem: (item: any | null) => void;
  openQuickSave: (item: any) => void;
  closeQuickSave: () => void;

  personId: number | null;
  personName: string;
  setPersonId: (id: number | null) => void;
  setPersonName: (name: string) => void;
  openPerson: (id: number, name: string) => void;
  closePerson: () => void;

  relationshipInitialSourceKey: string;
  setRelationshipInitialSourceKey: (key: string) => void;

  addCustomOpen: boolean;
  setAddCustomOpen: (open: boolean) => void;
  openAddCustom: () => void;
  closeAddCustom: () => void;

  profileOpen: boolean;
  setProfileOpen: (open: boolean) => void;
  openProfile: () => void;
  closeProfile: () => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;

  pendingBackup: any | null;
  setPendingBackup: (backup: any | null) => void;
  openPendingBackup: (backup: any) => void;
  closePendingBackup: () => void;
}

export function useAppModals(): AppModalsState {
  const [detailItem, setDetailItem] = useState<any | null>(null);
  const [quickSaveItem, setQuickSaveItem] = useState<any | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string>('');
  const [relationshipInitialSourceKey, setRelationshipInitialSourceKey] = useState<string>('');
  const [addCustomOpen, setAddCustomOpen] = useState<boolean>(false);
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [pendingBackup, setPendingBackup] = useState<any | null>(null);

  const openDetail = useCallback((item: any) => setDetailItem(item), []);
  const closeDetail = useCallback(() => setDetailItem(null), []);

  const openQuickSave = useCallback((item: any) => setQuickSaveItem(item), []);
  const closeQuickSave = useCallback(() => setQuickSaveItem(null), []);

  const openPerson = useCallback((id: number, name: string) => {
    setPersonId(id);
    setPersonName(name);
  }, []);
  const closePerson = useCallback(() => {
    setPersonId(null);
    setPersonName('');
  }, []);

  const openAddCustom = useCallback(() => setAddCustomOpen(true), []);
  const closeAddCustom = useCallback(() => setAddCustomOpen(false), []);

  const openProfile = useCallback(() => setProfileOpen(true), []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);

  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), []);

  const openPendingBackup = useCallback((backup: any) => setPendingBackup(backup), []);
  const closePendingBackup = useCallback(() => setPendingBackup(null), []);

  return {
    detailItem,
    setDetailItem,
    openDetail,
    closeDetail,

    quickSaveItem,
    setQuickSaveItem,
    openQuickSave,
    closeQuickSave,

    personId,
    personName,
    setPersonId,
    setPersonName,
    openPerson,
    closePerson,

    relationshipInitialSourceKey,
    setRelationshipInitialSourceKey,

    addCustomOpen,
    setAddCustomOpen,
    openAddCustom,
    closeAddCustom,

    profileOpen,
    setProfileOpen,
    openProfile,
    closeProfile,

    commandPaletteOpen,
    setCommandPaletteOpen,
    openCommandPalette,
    closeCommandPalette,

    pendingBackup,
    setPendingBackup,
    openPendingBackup,
    closePendingBackup,
  };
}
