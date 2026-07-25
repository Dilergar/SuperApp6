import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Куда идти за редактором для КОНКРЕТНОГО документа. Адрес никогда не хардкодится и
 * никогда не берётся из пользовательского ввода: только белый список из env
 * (DOCS_EDITOR_URL, можно несколько через запятую) — на эти адреса наш сервер ходит
 * сам (discovery, конвертация), то есть свободный выбор базы был бы SSRF.
 *
 * Выбор ЛИПКИЙ: узел запоминается в Document.editorBaseUrl и переиспользуется, пока
 * жива правка. Два узла на одном документе = два брокера в памяти = молча потерянные
 * правки одного из них; в v1 узел один (GET /docs/status объявляет singleNode), но
 * решение «по документу» заложено сразу, чтобы шардирование не требовало переделки.
 */
@Injectable()
export class DocsRouterService {
  private readonly logger = new Logger(DocsRouterService.name);

  /** Белый список узлов редактора (нормализованный, без хвостовых слэшей) */
  get bases(): string[] {
    return (process.env.DOCS_EDITOR_URL ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }

  /** Движок инертен без адреса редактора (паттерн core/calls без LIVEKIT_*) */
  get enabled(): boolean {
    return this.bases.length > 0;
  }

  /** v1-инвариант: один узел обслуживает все документы */
  get singleNode(): boolean {
    return this.bases.length <= 1;
  }

  /**
   * Адрес НАШЕГО API, каким его видит КОНТЕЙНЕР редактора. В разработке это НЕ то же
   * самое, что адрес для браузера: браузер грузит iframe с localhost:9980, а редактор
   * из контейнера стучится к нам на host.docker.internal:3001. Молчаливый откат на
   * localhost внутри чужого контейнера — причина классического «WOPI::CheckFileInfo failed».
   */
  get wopiPublicBase(): string {
    const base =
      process.env.DOCS_WOPI_PUBLIC_URL ||
      process.env.API_PUBLIC_URL ||
      `http://localhost:${process.env.PORT ?? 3001}`;
    return base.replace(/\/+$/, '');
  }

  /** WOPISrc документа — то, что редактор дёргает как CheckFileInfo/GetFile/PutFile */
  wopiSrc(documentId: string): string {
    return `${this.wopiPublicBase}/api/wopi/files/${documentId}`;
  }

  /**
   * База узла для документа: липкая, если уже выбрана и всё ещё в белом списке
   * (узел вывели из эксплуатации → документ переезжает на живой), иначе —
   * детерминированный выбор по id документа (стабилен между инстансами API).
   */
  resolveBase(documentId: string, sticky?: string | null): string {
    const bases = this.bases;
    if (!bases.length) throw new ServiceUnavailableException('Редактор документов не подключен');
    if (sticky) {
      const normalized = sticky.replace(/\/+$/, '');
      if (bases.includes(normalized)) return normalized;
      this.logger.warn(`узел ${normalized} вне белого списка — документ ${documentId} переезжает`);
    }
    if (bases.length === 1) return bases[0];
    const digest = createHash('sha256').update(documentId).digest();
    return bases[digest.readUInt32BE(0) % bases.length];
  }
}
