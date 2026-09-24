import { Injectable, OnModuleInit } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { VisibilityTypeRegistry } from '../../core/visibility/visibility.registry';
import { PaymentCardsService } from '../wallet/payment-cards.service';

const WS_CONTEXT = 'workspace';
/** Реквизиты сотрудника, которые раскрываются по одной записи (строгие поля `staff.member`) */
const MEMBER_USER_FIELDS = ['iin', 'residentialAddress', 'idDocNumber', 'idDocIssuedBy', 'idDocIssuedAt'] as const;

/**
 * Типы записей WorkspacesModule в движке видимости.
 *
 * `staff.member` — реквизитный блок сотрудника (владелец данных — ростер организации).
 * Раскрываются строгие поля ОДНОЙ записи: ИИН, адрес, удостоверение, IBAN карты. Право на
 * запись — зритель и субъект оба в команде этой организации (как у ростера); полный номер
 * карты провайдер не читает никогда — секрет раскрытию не подлежит (R11).
 *
 * `workspace.card` (R10): анкета и реквизиты организации.
 * Раскрывается ровно одно — IBAN банковского счёта (строгое поле: владелец/админ видят маску
 * и раскрывают по одной записи). Право на ЗАПИСЬ — команда организации (как у блока
 * реквизитов); чужой или несуществующий счёт — `null` (движок отвечает одинаковым 404).
 */
@Injectable()
export class WorkspacesVisibilityProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly types: VisibilityTypeRegistry,
    private readonly paymentCards: PaymentCardsService,
  ) {}

  onModuleInit(): void {
    this.types.register('staff.member', {
      loadForReveal: async (viewerId, workspaceId, recordId, fields) => {
        if (!workspaceId) return null;
        const allowed = new Set<string>([...MEMBER_USER_FIELDS, 'paymentCardIban']);
        if (!fields.length || fields.some((f) => !allowed.has(f))) return null;
        const [viewerIn, subjectIn] = await Promise.all([this.inTeam(viewerId, workspaceId), this.inTeam(recordId, workspaceId)]);
        if (!viewerIn || !subjectIn) return null;
        const want = new Set(fields);
        const values: Record<string, unknown> = {};
        const userFields = MEMBER_USER_FIELDS.filter((f) => want.has(f));
        if (userFields.length) {
          const u = await this.db.user.findUnique({
            where: { id: recordId },
            select: { iin: true, residentialAddress: true, idDocNumber: true, idDocIssuedBy: true, idDocIssuedAt: true },
          });
          if (!u) return null;
          for (const f of userFields) {
            const v = u[f];
            values[f] = v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null);
          }
        }
        if (want.has('paymentCardIban')) {
          const card = (await this.paymentCards.primaryCardsLiteFor([recordId], { iban: true })).get(recordId);
          values.paymentCardIban = card?.iban ?? null;
        }
        return { ref: { recordId, subjectId: recordId, workspaceId }, values };
      },
    });

    this.types.register('workspace.card', {
      loadForReveal: async (viewerId, _hat, recordId, fields) => {
        if (fields.some((f) => f !== 'iban')) return null;
        const acc = await this.db.workspaceBankAccount.findUnique({ where: { id: recordId }, select: { id: true, iban: true, workspaceId: true } });
        if (!acc) return null;
        if (!(await this.inTeam(viewerId, acc.workspaceId))) return null;
        return { ref: { recordId: acc.id, subjectId: null, workspaceId: acc.workspaceId }, values: { iban: acc.iban } };
      },
    });
  }

  /** Человек в команде организации (Подрядчик — нет: ростер ему закрыт). */
  private async inTeam(userId: string, workspaceId: string): Promise<boolean> {
    const n = await this.db.userRole.count({
      where: { userId, context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
    });
    return n > 0;
  }
}
