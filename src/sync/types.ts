import type { PalletEvent } from '../domain/types';

export type OutboxStatus = 'READY' | 'WAITING';

export interface OutboxItem {
  eventId: string;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export type RemoteCreateResult = { status: 'CREATED' };

export type RemoteCreateErrorCode =
  | 'ALREADY_EXISTS'
  | 'TRANSIENT'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'UNAUTHENTICATED'
  | 'QUOTA_EXHAUSTED';

export class RemoteCreateError extends Error {
  constructor(
    public readonly code: RemoteCreateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteCreateError';
  }
}

export interface RemoteEventStore {
  createEvent(event: PalletEvent): Promise<RemoteCreateResult>;
  getEvent(id: string): Promise<PalletEvent | undefined>;
}

export interface RemoteReadableEventStore extends RemoteEventStore {
  listEvents(): Promise<PalletEvent[]>;
}
