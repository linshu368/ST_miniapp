import type { RecordMiniappEntryData } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';

export async function recordEntry(
  tgId: string,
  surface: 'mujian' | 'mijing',
  source: string | null,
  authDate: number
): Promise<RecordMiniappEntryData> {
  // One transaction owns identity, eligibility, deduplication and the legacy source counter.
  // authDate comes from verified initData; client clocks and body IDs are never accepted.
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      const rows = await tx.$queryRaw<Array<{ result: RecordMiniappEntryData }>>`
      SELECT miniapp_traffic.record_app_entry(${tgId}, ${surface}, ${source}, to_timestamp(${authDate}::double precision)) AS result
    `;
      if (!rows[0]?.result.recorded) throw new Error('Entry was not persisted');
      return rows[0].result;
    },
    { maxWait: 2000, timeout: 8000 }
  );
}
