import { Injectable, OnModuleInit } from '@nestjs/common';
import { CalendarLayersRegistry, CalendarLayerResult } from '../calendar/calendar-layers.registry';
import { FinancesService } from './finances.service';

/**
 * Слой «Платежи» в календаре: дни платежей по долгам + повторяющиеся операции
 * личной книги — виртуально, со значками (значок счёта долга / категории повтора)
 * и сводкой периода («Платежи: … · после них ≈ …»). Денежная семантика целиком
 * у FinancesService; здесь — только регистрация в розетке календаря-платформы.
 */
@Injectable()
export class FinancesCalendarProvider implements OnModuleInit {
  constructor(
    private readonly registry: CalendarLayersRegistry,
    private readonly finances: FinancesService,
  ) {}

  onModuleInit(): void {
    this.registry.register('finance', {
      provide: (userId, from, to): Promise<CalendarLayerResult> =>
        this.finances.getPaymentsForCalendar(userId, from, to),
    });
  }
}
