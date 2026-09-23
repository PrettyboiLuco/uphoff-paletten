import type { UphoffLocalDb } from '../persistence/localDb';
import type { OperationalError, OpsSeverity } from './types';

export async function logOperationalError(
  db: UphoffLocalDb,
  input: {
    code: string;
    severity: OpsSeverity;
    message: string;
    occurredAt: string;
    context?: OperationalError['context'];
  },
): Promise<OperationalError> {
  const record: OperationalError = {
    id: crypto.randomUUID(),
    code: input.code,
    severity: input.severity,
    message: input.message,
    occurredAt: input.occurredAt,
    ...(input.context ? { context: input.context } : {}),
  };

  await db.errors.add(record);
  return record;
}

export async function recentOperationalErrors(
  db: UphoffLocalDb,
  limit = 50,
): Promise<OperationalError[]> {
  return db.errors.orderBy('occurredAt').reverse().limit(limit).toArray();
}
