export type EventArt =
  | 'ZUGANG'
  | 'ABGANG'
  | 'KORREKTUR'
  | 'ANFANGSBESTAND'
  | 'INVENTUR'
  | 'UMBUCHUNG';

export type SyncState = 'LOCAL_ONLY' | 'PENDING' | 'CONFIRMED' | 'REJECTED';

export interface PalletEvent {
  id: string;
  geraetId: string;
  person?: string;
  sorte: string;
  art: EventArt;
  delta: number;
  buchungszeit: string;
  serverzeit?: string;
  konfigVersion: number;
  vorgangId?: string;
  korrigiertId?: string;
  umbuchungId?: string;
  clockSkewFlag?: boolean;
}

export interface StoredEvent extends PalletEvent {
  syncState: SyncState;
  createdLocalAt: string;
  rejectionReason?: string;
}

export interface Projection {
  bestandGesamt: number;
  bestandJeSorte: Record<string, number>;
  dazugekommen: number;
  weggekommen: number;
  inventurdifferenz: number;
  anomalies: string[];
}

export interface OperationAssessment {
  netDelta: number;
  warning: 'NONE' | 'ZERO_NET' | 'WRONG_SIGN';
}
