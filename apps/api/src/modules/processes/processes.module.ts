import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ProcessNodeRegistry } from './process-node.registry';
import { ProcessEngineService } from './process-engine.service';
import { ProcessesService } from './processes.service';
import { ProcessesController } from './processes.controller';
import { ProcessWebhookController } from './process-webhook.controller';
import { ProcessesEventsListener } from './processes.events';
import { ProcessTriggerRouter } from './process-triggers.service';
import { ProcessesCron } from './processes.cron';
import { ProcessApprovalsProvider } from './process-approvals.provider';

/**
 * «Процессы» (B2B) — нодовый движок бизнес-процессов (Фазы 1–3).
 * Реестр нод — 5-й платформенный реестр; человеческий шаг делегирует Задачнику;
 * движок — token-walker строками БД + Redis-лок + крон-добивка; Ф3 — триггеры
 * (событие/расписание/вебхук) + HTTP-нода + сейф кредов.
 */
@Module({
  imports: [TasksModule],
  controllers: [ProcessesController, ProcessWebhookController],
  providers: [
    ProcessNodeRegistry,
    ProcessEngineService,
    ProcessesService,
    ProcessTriggerRouter,
    ProcessesEventsListener,
    ProcessesCron,
    // Регистрация в движке согласований: Процессы и предмет («запуск процесса»),
    // и ведущий (хук возврата токена). Движок Процессы не импортирует.
    ProcessApprovalsProvider,
    // Строковый токен для синхронного хука Задачника (ModuleRef, без циклического импорта) —
    // тот же паттерн, что 'ShopService' для settlement заказов.
    { provide: 'ProcessesService', useExisting: ProcessesService },
  ],
  exports: [ProcessesService, ProcessNodeRegistry],
})
export class ProcessesModule {}
