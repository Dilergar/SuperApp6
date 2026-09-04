import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CalendarShiftItem } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import {
  CalendarLayersRegistry,
  type CalendarLayerResult,
} from '../calendar/calendar-layers.registry';

/**
 * Слой «Смены» в личном календаре: ОПУБЛИКОВАННЫЕ смены зрителя, read-only.
 * Регистрирует ВЛАДЕЛЕЦ данных (правило реестра слоёв) — календарь про объекты
 * не знает. Черновики в личный календарь не попадают никогда: пока график не
 * опубликован, у человека его нет.
 */
@Injectable()
export class ObjectsCalendarProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly layers: CalendarLayersRegistry,
  ) {}

  onModuleInit(): void {
    this.layers.register('shifts', { provide: (userId, from, to) => this.provide(userId, from, to) });
  }

  private async provide(userId: string, from: Date, to: Date): Promise<CalendarLayerResult> {
    const rows = await this.db.shift.findMany({
      where: {
        userId,
        status: 'published',
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      include: {
        branch: { select: { name: true } },
        position: { select: { name: true } },
        template: { select: { color: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 500,
    });

    const items: CalendarShiftItem[] = rows.map((s) => ({
      kind: 'shifts',
      id: s.id,
      title: `${s.branch.name} · ${s.position.name}`,
      start: s.startsAt.toISOString(),
      end: s.endsAt.toISOString(),
      icon: 'calendarCheck',
      color: s.template?.color ?? null,
      href: `/workspaces/${s.workspaceId}/objects/${s.branchId}/shifts`,
      branchId: s.branchId,
      status: 'published',
    }));

    const totalMin = rows.reduce(
      (sum, s) => sum + Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000 - s.breakMin),
      0,
    );
    return {
      items,
      summary: rows.length ? `Смен: ${rows.length} · ${Math.round(totalMin / 60)} ч` : null,
    };
  }
}
