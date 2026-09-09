import { Injectable, OnModuleInit } from '@nestjs/common';
import type { RichCardPayload } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { ObjectsService } from './objects.service';
import { ShiftsService } from './shifts.service';

/**
 * Rich card «Смена» (Принцип 3): открытую смену кидают в чат объекта — «кто
 * возьмёт субботу?» — и её берут прямо оттуда кнопкой.
 *
 * Право на действие ПЕРЕПРОВЕРЯЕТ движок смен в момент нажатия (не карточка при
 * рендере): между показом и кликом смену могли занять.
 */
@Injectable()
export class ObjectsCardsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: RichCardRegistry,
    private readonly objects: ObjectsService,
    private readonly shifts: ShiftsService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.registry.registerRenderer('shift', (deps, viewerId, refId) => this.render(deps, viewerId, refId));
    this.registry.registerAction('shift.take', {
      // Способности `shift.*` нет намеренно: смена не несёт своих tuples, право
      // считается по ОБЪЕКТУ внутри take() (грант на объект или его предка).
      handler: (userId, refId) => this.take(userId, refId),
    });
  }

  private async take(userId: string, shiftId: string): Promise<void> {
    const shift = await this.db.shift.findUnique({
      where: { id: shiftId },
      select: { workspaceId: true },
    });
    if (!shift) return;
    await this.shifts.take(userId, shift.workspaceId, shiftId);
  }

  private async render(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
  ): Promise<RichCardPayload | null> {
    const shift = await deps.db.shift.findUnique({
      where: { id: refId },
      include: {
        branch: { select: { id: true, name: true, ancestorIds: true, workspaceId: true, timeZone: true } },
        position: { select: { name: true } },
        template: { select: { name: true } },
      },
    });
    if (!shift) return null;
    const scope = await this.objects.scopeOf(viewerId, shift.workspaceId);
    const caps = this.objects.capsFor(scope, shift.branch);
    if (!caps.view) return null;

    const open = !shift.userId && shift.status === 'published';
    const t = (key: string) => this.i18n.translate(key);
    // Часы смены — в поясе ОБЪЕКТА (смена живёт по его времени, а не по UTC),
    // локальный день — без пояса вовсе: это дата-ярлык, а не момент.
    const fmt = this.i18n.format(this.i18n.locale, shift.branch.timeZone);
    const timeLabel = fmt.timeRange(shift.startsAt, shift.endsAt);
    const dayLabel = this.i18n.format(this.i18n.locale, 'UTC').date(shift.localDate);
    return {
      kind: 'rich_card',
      cardType: 'shift',
      ref: { type: 'shift', id: refId },
      title: `${shift.branch.name} · ${shift.position.name}`,
      subtitle: `${dayLabel} · ${timeLabel}`,
      icon: '🗓️',
      imageUrl: null,
      fields: [
        ...(shift.template?.name ? [{ label: t('richCards.shift.template'), value: shift.template.name }] : []),
        {
          label: t('common.labels.status'),
          value: open
            ? t('richCards.shift.open')
            : shift.status === 'published'
              ? t('richCards.shift.taken')
              : t('objects.shiftStatus.draft'),
        },
      ],
      progress: null,
      status: open ? t('richCards.shift.openStatus') : null,
      actions: open ? [{ key: 'shift.take', label: t('richCards.shift.take'), style: 'primary' }] : [],
      href: `/workspaces/${shift.workspaceId}/objects/${shift.branchId}/shifts`,
    };
  }
}
