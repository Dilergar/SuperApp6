import { Global, Module } from '@nestjs/common';
import { isDevEnv } from '../../shared/config/env.validation';
import { ConsentsActionsService } from './consents.actions.service';
import { ConsentsController } from './consents.controller';
import { ConsentsDevController } from './consents.dev';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsIncidentsService } from './consents.incidents.service';
import { ConsentsJobs } from './consents.jobs';
import { ConsentsPlatformController, ConsentsPlatformProvider } from './consents.platform.provider';
import { ConsentsRevokeRegistry } from './consents.registry';
import { ConsentsSeedService } from './consents.seed.service';
import { ConsentsService } from './consents.service';

/**
 * core/consents — движок согласий (24-й): документы платформы версиями (контент в БД, подпись
 * платформы, хэш-цепочка), записи приёмки как доказательство, шлюз новой версии, учёт действий
 * с ПДн и журнал инцидентов. Лёгкое ядро шлюза живёт в `gate/` отдельным @Global-модулем —
 * его держат валидатор сессий, глобальный гард и интерцептор контекста.
 *
 * @Global: приёмку зовут регистрация, создание организации и интеграции; учёт действий —
 * каналы доставки, вебхуки, ссылки наружу. Движки, на которые опирается (keys, jobs,
 * notifications, analytics, platform, sign, files, templates), сами @Global.
 */
@Global()
@Module({
  // Дев-полигон — только в development/test: в production контроллера нет вовсе
  controllers: isDevEnv() ? [ConsentsController, ConsentsPlatformController, ConsentsDevController] : [ConsentsController, ConsentsPlatformController],
  providers: [
    ConsentsRevokeRegistry,
    ConsentsDocumentsService,
    ConsentsActionsService,
    ConsentsIncidentsService,
    ConsentsService,
    ConsentsJobs,
    ConsentsPlatformProvider,
    ConsentsSeedService,
  ],
  exports: [ConsentsService, ConsentsDocumentsService, ConsentsActionsService, ConsentsRevokeRegistry, ConsentsIncidentsService],
})
export class ConsentsModule {}
