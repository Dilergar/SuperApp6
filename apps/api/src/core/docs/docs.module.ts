import { Global, Module } from '@nestjs/common';
import { DocsService } from './docs.service';
import { DocsTokenService } from './docs-token.service';
import { DocsRouterService } from './docs-router.service';
import { DocsEditorClient } from './docs-editor.client';
import { DocsVersionsService } from './docs-versions.service';
import { DocsRenditionService } from './docs-rendition.service';
import { DocsShareLinksProvider } from './docs-share-links.provider';
import { DocsCron } from './docs.cron';
import { DocsController } from './docs.controller';
import { WopiController } from './wopi.controller';

/**
 * Движок документов (core/docs) — 12-й платформенный: работа с офисными документами
 * без потери верности формата. Файл всё время остаётся в родном формате; редактор —
 * внешний WOPI-клиент (Collabora), сменная деталь в розетке, как драйверы хранилища
 * или STT. Здесь: WOPI-хост, права, сессии-блокировки, версии-вехи.
 *
 * @Global — потребители (задачи, чат, будущий ЭДО) инжектят DocsService напрямую.
 * Инертен без DOCS_EDITOR_URL (паттерн core/calls без LIVEKIT_*): кнопок в вебе нет,
 * WOPI-роуты отвечают 404.
 */
@Global()
@Module({
  controllers: [DocsController, WopiController],
  providers: [
    DocsService,
    DocsTokenService,
    DocsRouterService,
    DocsEditorClient,
    DocsVersionsService,
    DocsRenditionService,
    DocsShareLinksProvider,
    DocsCron,
  ],
  // DocsRenditionService экспортирован для сервиса «Документы»: PDF-отпечаток на
  // маршруте снимается его же контентно-адресуемым путём, а не второй конвертацией.
  exports: [DocsService, DocsRouterService, DocsRenditionService],
})
export class DocsModule {}
