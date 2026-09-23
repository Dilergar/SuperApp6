import { Injectable } from '@nestjs/common';
import type { SecurityMyDataExportDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { AUDIT_EVENT_ENTITY } from './audit.constants';
import { auditActorKindOf } from './audit.codes';
import { AuditQueryService, AUDIT_ROW_SELECT, type AuditRow } from './audit.query.service';
import { AuditService } from './audit.service';

/** Потолок выгрузки «Мои данные» за раз (новейшие события). */
const MY_DATA_MAX_ROWS = 10_000;

/**
 * «Мои данные» журнала безопасности (ЗоПД ст. 24 — право на доступ к своим данным): всё, что
 * журнал знает о человеке, включая ПОЛНЫЙ IP его событий (человеку в ленте и организации он не
 * показывается никогда — только здесь, ему самому). Окно ленты (365 дней) выгрузку не режет:
 * это его данные за весь срок хранения. Выгрузка — событие `data.export{my_data}`.
 *
 * IP — только там, где адрес ЕГО: действовал он сам или аноним на его аккаунт (неудачный вход,
 * заморозка без входа — «откуда ломились»). Адрес админа, сменившего ему роль, или сотрудника
 * платформы, заморозившего аккаунт, — чужие персональные данные: не отдаются.
 * Право — вызывающий (контроллер: своя сессия, прошедшая cooling).
 */
@Injectable()
export class AuditMyDataService {
  constructor(
    private readonly db: DatabaseService,
    private readonly query: AuditQueryService,
    private readonly envelope: KeysEnvelopeService,
    private readonly audit: AuditService,
  ) {}

  async export(userId: string): Promise<SecurityMyDataExportDto> {
    const rows = await this.db.securityEvent.findMany({
      where: { visSubject: true, subjectUserId: userId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: MY_DATA_MAX_ROWS + 1,
      select: { ...AUDIT_ROW_SELECT, ipEnc: true },
    });
    const page = rows.slice(0, MY_DATA_MAX_ROWS);
    const dtos = await this.query.toDtos({ kind: 'subject', userId }, page.map(({ ipEnc: _ip, ...r }) => r as AuditRow));
    const out: SecurityMyDataExportDto['rows'] = [];
    for (let i = 0; i < page.length; i++) {
      const row = page[i]!;
      let ip: string | null = null;
      if (row.ipEnc && ownAddress(userId, row)) {
        const r = await this.envelope.tryDecrypt({ type: 'platform' }, { entity: AUDIT_EVENT_ENTITY, field: 'ip', ownerType: 'platform', ownerId: 'platform' }, row.ipEnc);
        ip = r.ok ? r.value : null;
      }
      out.push({ ...dtos[i]!, ip });
    }
    await this.audit.record(null, { key: 'data.export', subjectUserId: userId, details: { source: 'my_data', rows: out.length } });
    return { generatedAt: new Date().toISOString(), rows: out, truncated: rows.length > MY_DATA_MAX_ROWS };
  }
}

/** Адрес события — адрес самого человека: действовал он сам или аноним на его аккаунт. */
export function ownAddress(userId: string, row: { actorKind: number; actorId: string | null }): boolean {
  const kind = auditActorKindOf(row.actorKind);
  // Гость ссылки — другой человек (его адрес — его данные); аноним до входа — попытка на ЭТОТ аккаунт
  if (kind === 'anonymous') return !row.actorId;
  return kind === 'user' && row.actorId === userId;
}
