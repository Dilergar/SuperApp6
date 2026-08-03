import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DI_TOKENS } from '../../shared/di-tokens';
import { ApprovalsRegistry } from '../../core/approvals/approvals.registry';
import { ORG_DOCUMENT_REF_TYPE } from '@superapp/shared';
import { DriveModule } from '../drive/drive.module';
import { StaffModule } from '../staff/staff.module';
import { DocumentsService, type ProcessesStarter } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentsDevController } from './documents.dev';
import { isDevEnv } from '../../shared/config/env.validation';
import { DocumentsJobs } from './documents.jobs';
import { DocumentsRegistriesProvider } from './documents-registries.provider';

/**
 * Сервис «Документы» (B2B) — документооборот организации.
 *
 * Импортирует Диск (подшивка) и «Сотрудников» (стороны документа). Движки —
 * `core/docs`, `core/templates`, `core/approvals`, `core/files`, `core/jobs`,
 * `core/chatter`, `core/search` — приходят из @Global-модулей.
 *
 * С Процессами связь ОБОЮДНАЯ и обе стороны ленивые: ноды маршрута зовут сервис
 * строковым токеном `DI_TOKENS.DocumentsService`, а сервис зовёт запуск маршрута
 * через ссылку, поставленную на bootstrap. Прямые инъекции замкнули бы модули.
 */
@Module({
  imports: [DriveModule, StaffModule],
  // Дев-полигон системных путей нод маршрута: в production этих маршрутов НЕТ (404),
  // а не «есть, но отвечают 403» — то же правило, что у полигонов джобов и согласований.
  controllers: isDevEnv() ? [DocumentsController, DocumentsDevController] : [DocumentsController],
  providers: [
    DocumentsService,
    DocumentsJobs,
    DocumentsRegistriesProvider,
    { provide: DI_TOKENS.DocumentsService, useExisting: DocumentsService },
  ],
  exports: [DocumentsService, DI_TOKENS.DocumentsService],
})
export class DocumentsModule implements OnApplicationBootstrap {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // Запуск маршрута: резолвим Процессы после старта — на этот момент оба модуля
    // уже собраны, и цикла в графе зависимостей нет.
    const processes = this.moduleRef.get<ProcessesStarter>(DI_TOKENS.ProcessesService, { strict: false });
    this.documents.setProcessesService(processes ?? null);

    // Возврат управления из движка согласований: маршрут ведут Процессы, но когда
    // документ ушёл на решение БЕЗ процесса (маршрут не нарисован), закрыть его
    // некому — этот хук и закрывает такой случай.
    this.approvals.registerOrigin(ORG_DOCUMENT_REF_TYPE, {
      onResolved: (originRef, outcome) => this.documents.systemResolve(originRef, outcome),
    });
  }
}
