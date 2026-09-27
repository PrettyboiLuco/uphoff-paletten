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
  | 'QUOTA_EXHAUSTED'
  | 'INSUFFICIENT_STOCK';

/**
 * Single source of truth for what the outbox does with each remote error.
 *
 * A raw Firebase error never proves that this exact booking content can never
 * be accepted. INVALID_ARGUMENT, too, can originate outside the event data.
 * PERMISSION_DENIED
 * is NOT deterministic here: a briefly disabled device, a missing App Check
 * token or a device clock ahead of the server all produce it and all recover.
 * Adding a new error code without a policy fails `npm run typecheck`.
 */
export const REMOTE_ERROR_POLICY = {
  ALREADY_EXISTS: 'VERIFY',
  TRANSIENT: 'RETRY',
  UNAUTHENTICATED: 'RETRY',
  QUOTA_EXHAUSTED: 'RETRY',
  PERMISSION_DENIED: 'RETRY',
  INVALID_ARGUMENT: 'RETRY',
  INSUFFICIENT_STOCK: 'RETRY',
} as const satisfies Record<RemoteCreateErrorCode, 'VERIFY' | 'RETRY'>;

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

export interface RemoteCursor {
  serverzeit: string;
  id: string;
}

export interface RemoteReadableEventStore extends RemoteEventStore {
  listEvents(): Promise<PalletEvent[]>;
  listEventsAfter?(cursor: RemoteCursor): Promise<PalletEvent[]>;
}

export type RemoteUnsubscribe = () => void;

export interface RemoteRealtimeEventStore extends RemoteReadableEventStore {
  subscribeEvents(
    onEvent: (event: PalletEvent) => void | Promise<void>,
    onError: (error: unknown) => void,
    after?: RemoteCursor,
  ): RemoteUnsubscribe;
}
