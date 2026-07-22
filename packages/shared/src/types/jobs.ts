export type JobStatus = 'available' | 'executing' | 'completed' | 'discarded' | 'cancelled';

/** GET /jobs/stats — дев-наблюдаемость движка джобов (только NODE_ENV=development). */
export interface JobStatsDto {
  counts: Array<{ type: string; status: JobStatus; count: number }>;
  /** Возраст самого старого невзятого джоба (сек) — здоровье поллера. */
  oldestAvailableAgeSec: number | null;
  recentDiscarded: Array<{
    id: string; // BigInt → string
    type: string;
    attempts: number;
    lastError: string | null;
    finishedAt: string | null;
  }>;
}
