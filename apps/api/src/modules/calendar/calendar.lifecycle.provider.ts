import { Injectable, OnModuleInit } from '@nestjs/common';
import { CALENDAR_LIMITS } from '@superapp/shared';
import { LifecyclePurgeHandlerRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
import { CalendarService } from './calendar.service';

/**
 * Календарь в движке сроков core/lifecycle: `calendar.trash` (политика `CalendarEvent`) —
 * корзина `CALENDAR_LIMITS.trashRetentionDays`: мастер-событие уходит навсегда (исключения,
 * напоминания, участники — каскадом FK; копия в Google снята ещё при скрытии).
 */
@Injectable()
export class CalendarLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly calendar: CalendarService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('calendar.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.calendar.purgeTrashBatch({ before: this.cutoff(), limit, cursor, releasable }),
      estimate: () => this.calendar.countTrashDue(this.cutoff()),
    });
  }

  private cutoff(): Date {
    return new Date(Date.now() - CALENDAR_LIMITS.trashRetentionDays * 86_400_000);
  }
}
