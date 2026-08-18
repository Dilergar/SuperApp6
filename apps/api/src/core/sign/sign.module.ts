import { Global, Module, OnModuleInit } from '@nestjs/common';
import { SIGN_ACT_REF_TYPE, SIGN_REQUEST_REF_TYPE } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { FilesRefRegistry } from '../files/files-ref.registry';
import { TemplatesModule } from '../templates/templates.module';
import { SignController, SignQrBridgeController } from './sign.controller';
import { SignCron } from './sign.cron';
import { SignDevController, SignDevProvider } from './sign.dev';
import { SignGuestController } from './sign-guest.controller';
import { SignInboxProvider } from './sign-inbox.provider';
import { SignJobs } from './sign.jobs';
import { SignProtocolService } from './sign-protocol.service';
import { SignShareLinksProvider } from './sign-share-links.provider';
import { SignStampService } from './sign-stamp.service';
import { SignQrService } from './sign-qr.service';
import { SignRegistry } from './sign.registry';
import { SignService } from './sign.service';
import { SignQrBridgeService } from './drivers/sign-qr.driver';
import { SignVerifierService } from './drivers/sign-verifier.driver';

/**
 * core/sign — 15-й платформенный движок: электронная подпись.
 *
 * Шаг 3 документной вертикали («Диск → шаблоны → ПОДПИСЬ → ЭДО → КЭДО»). До него
 * подпись в платформе была нажатием кнопки в «Ждут решения» — юридической силы
 * ноль. Теперь у подписи есть акт, замороженный предмет, криптография с
 * проверкой цепочки и OCSP на момент подписания, вечные доказательства,
 * экспортный пакет (ст. 62 ЦК) и открытая страница проверки (ст. 61 ЦК).
 *
 * @Global — потребители инжектят `SignService` (завести заявку, показать блок
 * «Подписи») и `SignRegistry` (зарегистрировать резолвер предмета). Движок не
 * импортирует ни один функциональный модуль: направление знания — только от
 * потребителя к движку.
 *
 * Единственная зависимость от другого ДВИЖКА, идущая «вперёд», — core/approvals:
 * подпись закрывает шаг маршрута закрывающим входом `decideAttested`. Здесь sign
 * такой же потребитель, как Документы, и обратной связи нет: approvals знает о
 * подписи ровно одно поле `requiredSignatureKind`.
 */
@Global()
@Module({
  // TemplatesModule — ради PdfRenderService: протокол подписания печатает тот же
  // Gotenberg, что и блочные документы. Один печатающий движок на платформу.
  imports: [TemplatesModule],
  controllers: isDevEnv()
    ? [SignController, SignQrBridgeController, SignGuestController, SignDevController]
    : [SignController, SignQrBridgeController, SignGuestController],
  providers: [
    SignService,
    SignRegistry,
    SignQrService,
    SignProtocolService,
    SignStampService,
    SignVerifierService,
    SignQrBridgeService,
    SignJobs,
    SignCron,
    SignDevProvider,
    // Внешний подписант по гостевой ссылке — первый потребитель слота `actions`
    // движка core/share-links (он ждал именно этого случая).
    SignShareLinksProvider,
    // Свободные подписи (внутренние подписанты ЭДО) в общей стопке «Ждут решения»
    SignInboxProvider,
  ],
  exports: [SignService, SignRegistry],
})
export class SignModule implements OnModuleInit {
  constructor(private readonly filesRegistry: FilesRefRegistry) {}

  /**
   * Файлы движка — доказательства, и доступ к ним НЕ наследуется от места.
   *
   * Резолвер объявлен пустым намеренно: замороженную копию и контейнер CMS
   * движок отдаёт только своими путями (`buildSystemDownloadUrl` после
   * собственной проверки прав и публичная страница проверки). Без регистрации
   * файл организации попал бы под общее правило «виден всей команде», и приказ
   * по личному делу читал бы любой сотрудник, узнавший fileId.
   */
  onModuleInit(): void {
    const evidenceResolver = {
      canView: async () => false,
      canAttach: async () => false,
      canEditContent: async () => false,
    };
    this.filesRegistry.register(SIGN_REQUEST_REF_TYPE, evidenceResolver, { scopedPlace: true });
    this.filesRegistry.register(SIGN_ACT_REF_TYPE, evidenceResolver, { scopedPlace: true });
  }
}
