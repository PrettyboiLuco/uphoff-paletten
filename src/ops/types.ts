export type OpsSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface OperationalError {
  id: string;
  occurredAt: string;
  code: string;
  severity: OpsSeverity;
  message: string;
  context?: Record<string, string | number | boolean | null>;
}

export interface BackupManifest {
  schemaVersion: 1;
  exportedAt: string;
  app: 'uphoff-paletten';
  eventCount: number;
  outboxCount: number;
  conflictCount: number;
}

export interface BackupPackage {
  manifest: BackupManifest;
  events: unknown[];
  outbox: unknown[];
  conflicts: unknown[];
}

export interface DeviceHealthSnapshot {
  checkedAt: string;
  eventCount: number;
  pendingCount: number;
  rejectedCount: number;
  conflictCount: number;
  checkCode: Record<string, { count: number; sum: number }>;
}
