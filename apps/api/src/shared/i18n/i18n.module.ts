import { Global, Module } from '@nestjs/common';
import { I18nService } from './i18n.service';

/**
 * Слова нужны ВЕЗДЕ — от фильтра исключений до джоба рассылки, — поэтому
 * модуль глобальный (как WorkspaceContextModule и DatabaseModule). Иначе
 * каждый из сорока модулей импортировал бы его руками, и первый забывший
 * получил бы отказ без текста.
 */
@Global()
@Module({
  providers: [I18nService],
  exports: [I18nService],
})
export class I18nModule {}
