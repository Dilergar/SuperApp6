import { Injectable, OnModuleInit } from '@nestjs/common';
import { CalendarLayersRegistry, CalendarLayerResult } from '../calendar/calendar-layers.registry';
import { TasksService } from './tasks.service';
import type { CalendarTaskItem } from '@superapp/shared';

/**
 * Слой «Задачи» в календаре: виртуальная проекция задач со сроком (ничего не
 * копируется — читаем живьём через TasksService.listForCalendar). Регистрация
 * в CalendarLayersRegistry — образец подключения сервиса к календарю-платформе.
 */
@Injectable()
export class TasksCalendarProvider implements OnModuleInit {
  constructor(
    private readonly registry: CalendarLayersRegistry,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.registry.register('tasks', {
      provide: (userId, from, to) => this.provide(userId, from, to),
    });
  }

  private async provide(userId: string, from: Date, to: Date): Promise<CalendarLayerResult> {
    const rows = await this.tasks.listForCalendar(userId, from, to);
    return { items: rows.map((t) => this.dto(t)) };
  }

  private dto(t: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: Date;
    allDay: boolean;
    overdue: boolean;
    role: string | null;
    coinReward: number | null;
  }): CalendarTaskItem {
    const iso = t.dueDate.toISOString();
    return {
      kind: 'task',
      taskId: t.id,
      title: t.title,
      status: t.status as CalendarTaskItem['status'],
      priority: t.priority as CalendarTaskItem['priority'],
      start: iso,
      end: iso,
      allDay: t.allDay,
      dueDate: iso,
      overdue: t.overdue,
      myRole: t.role as CalendarTaskItem['myRole'],
      coinReward: t.coinReward,
    };
  }
}
