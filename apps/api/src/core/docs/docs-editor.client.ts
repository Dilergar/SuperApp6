import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DOCS_LIMITS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { DocsRouterService } from './docs-router.service';

/** ext|mime → urlsrc действия «edit» из discovery редактора */
type DiscoveryMap = Record<string, string>;

/**
 * Клиент внешнего WOPI-редактора (первый драйвер — Collabora Online). Знает ровно две
 * вещи: где брать action-URL для расширения (hosting/discovery) и как попросить
 * конвертацию (cool/convert-to — ленивый PDF-отпечаток и текст для ИИ).
 *
 * Все исходящие вызовы идут ТОЛЬКО на адрес из белого списка env (DocsRouterService):
 * ни один параметр запроса не участвует в выборе хоста — иначе это был бы SSRF.
 */
@Injectable()
export class DocsEditorClient {
  private readonly logger = new Logger(DocsEditorClient.name);

  constructor(
    private readonly router: DocsRouterService,
    private readonly redis: RedisService,
  ) {}

  get enabled(): boolean {
    return this.router.enabled;
  }

  /**
   * action-URL редактора для формата. Discovery кэшируем в Redis: это статика сборки
   * редактора (меняется только при его обновлении), а дёргать её на каждое открытие —
   * лишний сетевой круг в самом заметном месте.
   */
  async actionUrl(base: string, ext: string, mime: string): Promise<string> {
    const map = await this.discovery(base);
    const urlsrc = map[ext.toLowerCase()] ?? map[mime.toLowerCase()];
    if (!urlsrc) {
      throw new ServiceUnavailableException(`Редактор не умеет открывать «${ext}»`);
    }
    return urlsrc;
  }

  private async discovery(base: string): Promise<DiscoveryMap> {
    const key = `docs:discovery:${base}`;
    const cached = await this.redis.getJson<DiscoveryMap>(key).catch(() => null);
    if (cached && Object.keys(cached).length) return cached;

    const xml = await this.fetchDiscovery(base);
    const map = this.parseDiscovery(xml, base);
    if (!Object.keys(map).length) {
      throw new ServiceUnavailableException('Редактор вернул пустой discovery');
    }
    await this.redis.setJson(key, map, DOCS_LIMITS.discoveryCacheSec).catch(() => undefined);
    return map;
  }

  private async fetchDiscovery(base: string): Promise<string> {
    const url = `${base}/hosting/discovery`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/xml,text/xml' },
        signal: AbortSignal.timeout(DOCS_LIMITS.editorRequestTimeoutMs),
      });
    } catch (err) {
      this.logger.warn(`discovery недоступен (${base}): ${String((err as Error)?.message ?? err)}`);
      throw new ServiceUnavailableException('Редактор документов недоступен');
    }
    if (!res.ok) {
      this.logger.warn(`discovery ответил ${res.status} (${base})`);
      throw new ServiceUnavailableException('Редактор документов недоступен');
    }
    return res.text();
  }

  /**
   * Разбор discovery без XML-библиотеки: нам нужны только пары «формат → urlsrc».
   * Ключуем И по расширению, И по MIME родительского <app> — разные сборки редактора
   * заполняют эти атрибуты по-разному, и опираться на одну из форм ненадёжно.
   */
  private parseDiscovery(xml: string, base: string): DiscoveryMap {
    const map: DiscoveryMap = {};
    const appRe = /<app\s+([^>]*?)>([\s\S]*?)<\/app>/gi;
    let app: RegExpExecArray | null;
    while ((app = appRe.exec(xml))) {
      const appName = /name="([^"]*)"/i.exec(app[1])?.[1] ?? '';
      const actionRe = /<action\s+([^>]*?)\/?>/gi;
      let action: RegExpExecArray | null;
      while ((action = actionRe.exec(app[2]))) {
        const attrs = action[1];
        const name = (/name="([^"]*)"/i.exec(attrs)?.[1] ?? '').toLowerCase();
        if (name !== 'edit') continue; // view/convert-to нам здесь не нужны
        const raw = /urlsrc="([^"]*)"/i.exec(attrs)?.[1];
        if (!raw) continue;
        const urlsrc = this.normalizeUrlsrc(raw, base);
        const ext = (/ext="([^"]*)"/i.exec(attrs)?.[1] ?? '').toLowerCase();
        if (ext) map[ext] = urlsrc;
        if (appName.includes('/')) map[appName.toLowerCase()] = urlsrc;
      }
    }
    return map;
  }

  /**
   * urlsrc из discovery приходит с адресом, которым редактор знает САМ СЕБЯ, и с
   * плейсхолдерами WOPI (<ui=UI_LLCC&>). Плейсхолдеры вырезаем (их подставляет хост),
   * а origin принудительно заменяем на настроенный: iframe грузит БРАУЗЕР, и адрес
   * должен быть браузерным, а не внутренним адресом контейнера.
   */
  private normalizeUrlsrc(raw: string, base: string): string {
    const stripped = raw.replace(/<[^>]*>/g, '');
    try {
      const parsed = new URL(stripped);
      return `${base}${parsed.pathname}${parsed.search}`;
    } catch {
      return stripped.startsWith('/') ? `${base}${stripped}` : stripped;
    }
  }

  /**
   * Конвертация документа средствами редактора (ленивый PDF-отпечаток под печать и
   * будущую ЭЦП; извлечение текста для RAG).
   *
   * Работаем ФАЙЛ→ФАЙЛ, а не байты→байты: документ бывает в сотни мегабайт, и держать
   * его в памяти трижды (исходник + копия под Blob + результат) — это OOM на паре
   * параллельных джобов. openAsBlob отдаёт содержимое лениво, ответ пишем потоком.
   */
  async convertTo(
    base: string,
    target: 'pdf' | 'txt',
    sourcePath: string,
    filename: string,
    outPath: string,
  ): Promise<void> {
    const form = new FormData();
    form.append('file', await fs.openAsBlob(sourcePath), filename);
    let res: Response;
    try {
      res = await fetch(`${base}/cool/convert-to/${target}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(DOCS_LIMITS.convertTimeoutMs),
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        `Конвертация недоступна: ${String((err as Error)?.message ?? err)}`,
      );
    }
    if (!res.ok || !res.body) throw new ServiceUnavailableException(`Конвертация вернула ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(outPath));
  }
}
