import { Injectable, Logger } from '@nestjs/common';
import { VISIBILITY_LIMITS, VISIBILITY_REDIS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { VisibilityMetrics } from './visibility.metrics';

const HOUR_MS = 3_600_000;
/** Ключ окна живёт чуть дольше часа: запись в конце часа не должна умереть раньше своего окна. */
const WINDOW_TTL_SEC = 3660;

/**
 * Детекция скрейпинга (WhatsApp 2025: 3,5 млрд номеров перебором без лимита; Uber God View):
 * сколько ЧУЖИХ записей с полями класса ≥ contact ушло зрителю ЦЕЛИКОМ за часовое окно. Порог
 * (`visibility.personalRowsPerHour`) пройден → тревога `detect.pii_scrape` организации и
 * платформе — один раз на окно. Блокировки нет намеренно: легитимный админ большого ростера
 * порог тоже пройдёт; решение — за организацией и безопасностью платформы (заморозка аккаунта,
 * отзыв ключа), а не за движком. Учёт — мимо пути ответа (fire-and-forget): сбой Redis не
 * трогает ни латентность, ни результат `shape()`.
 */
@Injectable()
export class VisibilityScrapeDetector {
  private readonly logger = new Logger(VisibilityScrapeDetector.name);

  constructor(
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly metrics: VisibilityMetrics,
  ) {}

  /**
   * Учесть пачку: `exposedRows` — строки не про самого зрителя, где хотя бы одно поле класса
   * ≥ contact (кроме присутствия и фото) ушло на уровне `full`. Гость и система не считаются.
   */
  count(viewer: { userId: string | null; kind: string; workspaceId: string | null }, recordType: string, exposedRows: number): void {
    if (exposedRows <= 0 || !viewer.userId || viewer.kind === 'system' || viewer.kind === 'guest') return;
    void this.tally(viewer.userId, viewer.workspaceId, recordType, exposedRows).catch((err: Error) => this.logger.warn(`scrape tally failed: ${err.message}`));
  }

  /** Учёт с ожиданием (дев-полигон и сьют): сколько в окне и сработала ли тревога этой пачкой. */
  async tally(userId: string, workspaceId: string | null, recordType: string, n: number): Promise<{ total: number; fired: boolean }> {
    const bucket = Math.floor(Date.now() / HOUR_MS);
    const key = VISIBILITY_REDIS.personalRows(userId, bucket);
    const res = await this.redis.getClient().multi().incrby(key, n).expire(key, WINDOW_TTL_SEC, 'NX').exec();
    const total = Number(res?.[0]?.[1] ?? 0);
    const limit = VISIBILITY_LIMITS.personalRowsPerHour;
    // Порог пересечён ЭТОЙ пачкой (до неё было меньше) — тревога один раз на окно
    if (!total || total < limit || total - n >= limit) return { total, fired: false };
    this.metrics.scrape.inc({ record_type: recordType });
    await this.audit.recordOnce(
      null,
      `vis:scrape:${userId}:${bucket}`,
      {
        key: 'detect.pii_scrape',
        workspaceId,
        subjectUserId: userId,
        actor: { kind: 'system' },
        details: { events: total, rows: total, windowMin: 60 },
      },
      WINDOW_TTL_SEC,
    );
    return { total, fired: true };
  }

  /** Сбросить окно человека (дев-полигон: сьют гоняет детекцию повторно). */
  async reset(userId: string): Promise<void> {
    const bucket = Math.floor(Date.now() / HOUR_MS);
    await this.redis.getClient().del(VISIBILITY_REDIS.personalRows(userId, bucket)).catch(() => undefined);
  }
}
