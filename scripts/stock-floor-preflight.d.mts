interface Heartbeat {
  lastSeen?: { toMillis(): number };
  appVersion?: string;
  syncState?: string;
  pendingCount?: number;
  rejectedCount?: number;
  eventCount?: number;
  checkCodeJson?: string;
}

export function assessActivationReadiness(input: {
  eventCount: number;
  checkCode: Record<string, { count: number; sum: number }>;
  devices: string[];
  heartbeats: Record<string, Heartbeat | null>;
  expectedVersion: string;
  nowMs: number;
}): string[];
