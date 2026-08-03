import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsRegistry } from './approvals.registry';
import { ApprovalsJobs } from './approvals.jobs';
import { ApprovalsRichCardProvider } from './approvals-rich-card.provider';
import { ApprovalsDevController, ApprovalsDevProvider } from './approvals.dev';
import { isDevEnv } from '../../shared/config/env.validation';

/**
 * core/approvals — 14-й платформенный движок: «Задачник для решений».
 *
 * Чинит асимметрию Процессов: нода «Задача человеку» создаёт настоящую задачу в
 * Задачнике, а нода «Одобрение» держала человека внутри канваса и показывала ему
 * строку текста без предмета. Теперь решение — своя сущность: знает свой предмет,
 * попадает в стопку «Ждут решения», в чат рич-карточкой и в журнал.
 *
 * Ветвления и условия остаются в Процессах: движок ведёт ПРЯМОЙ список шагов
 * (одинаковый order = параллельно), и второго маршрутизатора в платформе не будет.
 *
 * @Global — потребители инжектят ApprovalsService (завести заявку, отменить по
 * своему origin) и ApprovalsRegistry (зарегистрировать резолвер предмета, хук
 * возврата или источник стопки). Движок не импортирует ни один функциональный
 * модуль: направление знания — только от потребителя к движку.
 */
@Global()
@Module({
  // Дев-полигон — по тому же правилу, что у движка джобов: в production маршрутов
  // просто НЕТ (404), а не «есть, но отвечают 403».
  controllers: isDevEnv() ? [ApprovalsController, ApprovalsDevController] : [ApprovalsController],
  providers: [ApprovalsService, ApprovalsRegistry, ApprovalsJobs, ApprovalsRichCardProvider, ApprovalsDevProvider],
  exports: [ApprovalsService, ApprovalsRegistry],
})
export class ApprovalsModule {}
