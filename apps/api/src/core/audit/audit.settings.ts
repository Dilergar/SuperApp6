import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_SETTINGS, type AuditSetting } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { auditRetentionYears } from './audit.archive';
import { auditDigestIntervalMin } from './audit.digests';
import { AuditService } from './audit.service';

type SettingValue = number | boolean;

/** Значения настроек журнала этого процесса — те же формулы, что читают дайджесты и архив. */
export function auditSettingsNow(): Record<AuditSetting, SettingValue> {
  return {
    digest_interval_min: auditDigestIntervalMin(),
    retention_years: auditRetentionYears(),
    archive_enabled: process.env.AUDIT_ARCHIVE_ENABLED !== 'false',
    trusted_country: !!process.env.GEO_COUNTRY_HEADER?.trim(),
  };
}

/**
 * Смена настроек самого журнала (NIST AU-9: выключить архив или сократить срок хранения —
 * тоже событие). Настройки живут в окружении, поэтому сверка идёт на старте процесса: значение
 * каждой настройки сравнивается с `to` последнего `audit.settings.changed` этой настройки —
 * правда о прошлом значении сам журнал, отдельной таблицы нет. Расхождение → событие
 * (`from` → `to`), первый запуск → исходное значение (`reason_code: baseline`).
 *
 * Два процесса разной конфигурации на одной базе (выкатка) дадут событие на каждый старт —
 * это и есть сигнал: журнал пишет с разными правилами. Под advisory-замком — чтобы два
 * одновременных старта не записали одну смену дважды.
 */
@Injectable()
export class AuditSettingsCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditSettingsCheck.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const written = await this.check();
      if (written) this.logger.warn(`security log settings changed since the last start: ${written} event(s)`);
    } catch (err) {
      // Старт не валим: журнал продолжает писать; расхождение поймает следующий запуск
      this.logger.error(`security log settings check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Сверка; возвращает число записанных событий. */
  async check(): Promise<number> {
    const now = auditSettingsNow();
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('audit.settings'))`);
      let written = 0;
      for (const setting of AUDIT_SETTINGS) {
        const last = await tx.securityEvent.findFirst({
          where: { eventKey: 'audit.settings.changed', details: { path: ['setting'], equals: setting } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: { details: true },
        });
        const before = last ? ((last.details as { to?: SettingValue } | null)?.to ?? null) : null;
        if (last && before === now[setting]) continue;
        await this.audit.record(tx, {
          key: 'audit.settings.changed',
          actor: { kind: 'system' },
          reasonCode: last ? null : 'baseline',
          details: { setting, from: before, to: now[setting] },
        });
        written += 1;
      }
      return written;
    });
  }
}
