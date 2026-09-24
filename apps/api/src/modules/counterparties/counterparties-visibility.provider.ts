import { Injectable, OnModuleInit } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { VisibilityTypeRegistry } from '../../core/visibility/visibility.registry';

const COUNTERPARTY_FIELDS = new Set(['phone', 'email']);
const CONTACT_FIELDS = new Set(['contactPhone', 'contactEmail']);
const ACCOUNT_FIELDS = new Set(['iban']);

/**
 * Тип записи `counterparty` движка видимости. Раскрытие ОДНОЙ записи (если политика дала
 * раскрытие маски): `recordId` — строка, которой принадлежат поля (контрагент — телефон и
 * e-mail; контактное лицо — его телефон и e-mail; счёт — IBAN). Право на запись — команда
 * организации-владельца (Подрядчик изолирован), как у справочника; чужое — `null` (404).
 */
@Injectable()
export class CounterpartiesVisibilityProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly types: VisibilityTypeRegistry,
  ) {}

  onModuleInit(): void {
    this.types.register('counterparty', {
      loadForReveal: async (viewerId, workspaceId, recordId, fields) => {
        if (!workspaceId || !fields.length) return null;
        const all = (set: Set<string>) => fields.every((f) => set.has(f));
        let values: Record<string, unknown> | null = null;
        if (all(COUNTERPARTY_FIELDS)) {
          const r = await this.db.counterparty.findFirst({ where: { id: recordId, workspaceId }, select: { phone: true, email: true } });
          if (r) values = { phone: r.phone, email: r.email };
        } else if (all(CONTACT_FIELDS)) {
          const r = await this.db.counterpartyContact.findFirst({ where: { id: recordId, workspaceId }, select: { phone: true, email: true } });
          if (r) values = { contactPhone: r.phone, contactEmail: r.email };
        } else if (all(ACCOUNT_FIELDS)) {
          const r = await this.db.counterpartyBankAccount.findFirst({ where: { id: recordId, workspaceId }, select: { iban: true } });
          if (r) values = { iban: r.iban };
        }
        if (!values) return null;
        const member = await this.db.userRole.count({
          where: { userId: viewerId, context: 'workspace', tenantId: workspaceId, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
        });
        if (!member) return null;
        return {
          ref: { recordId, subjectId: null, workspaceId },
          values: Object.fromEntries(fields.map((f) => [f, values![f] ?? null])),
        };
      },
    });
  }
}
