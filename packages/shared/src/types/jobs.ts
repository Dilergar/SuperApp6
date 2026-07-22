export type JobStatus = 'available' | 'executing' | 'completed' | 'discarded' | 'cancelled';

/** GET /jobs/stats — дев-наблюдаемость движка джобов (только NODE_ENV=development). */
export interface JobStatsDto {
  counts: Array<{ type: string; status: JobStatus; count: number }>;
  /**
   * Возраст самого старого невзятого джоба (сек) — здоровье поллера. Считается
   * ТОЛЬКО по типам с обработчиком: джоб выключенной фичи ждёт не воркера, а
   * включения фичи, и в приборе «очередь встала» ему делать нечего.
   */
  oldestAvailableAgeSec: number | null;
  /**
   * Живые джобы типов, у которых на этом инстансе НЕТ обработчика. Две разные
   * причины: фича выключена переменными окружения (ClamAV/STT/LiveKit не заданы)
   * ИЛИ тип удалён/переименован между деплоями. Первое лечится включением фичи,
   * второе — осознанной чисткой; сами по себе такие строки не исполнятся и не
   * протухнут никогда, поэтому движок их показывает, а не прячет.
   */
  unhandled: Array<{ type: string; count: number; oldestAgeSec: number }>;
  recentDiscarded: Array<{
    id: string; // BigInt → string
    type: string;
    attempts: number;
    lastError: string | null;
    finishedAt: string | null;
  }>;
}
