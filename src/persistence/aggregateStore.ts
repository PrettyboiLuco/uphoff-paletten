import type {
  AggregateRevision,
  AggregateStore,
} from '../statistics/aggregates';
import type { UphoffLocalDb } from './localDb';

export class IndexedDbAggregateStore implements AggregateStore {
  constructor(private readonly db: UphoffLocalDb) {}

  async list(
    bucketType: 'DAY' | 'MONTH',
    bucketKey: string,
  ): Promise<AggregateRevision[]> {
    const revisions = await this.db.aggregates
      .where('[bucketType+bucketKey]')
      .equals([bucketType, bucketKey])
      .toArray();

    return revisions.sort((a, b) => a.revision - b.revision);
  }

  async append(revision: AggregateRevision): Promise<void> {
    await this.db.aggregates.add(revision);
  }
}
