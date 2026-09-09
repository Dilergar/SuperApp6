import { Injectable, Logger } from '@nestjs/common';
import { SOURCE_LOCALE, type Locale } from '@superapp/i18n';
import { trustedFetch } from '../../shared/http';
import { I18nService } from '../../shared/i18n/i18n.service';

/**
 * HTML → PDF для блочных документов: печатает Chromium в контейнере Gotenberg
 * (docker-профиль `pdf`). Тот же движок, что показывает превью в браузере, —
 * на этом держится совпадение «что видишь — то и подпишут» один в один.
 *
 * Инертен без GOTENBERG_URL (паттерн VOICE_STT_URL / DOCS_EDITOR_URL): рендер
 * недоступен → потребитель честно деградирует, а не падает. Адрес — только из
 * env, пользовательский ввод сюда не попадает никогда (иначе SSRF).
 */
@Injectable()
export class PdfRenderService {
  private readonly logger = new Logger(PdfRenderService.name);
  private readonly baseUrl = (process.env.GOTENBERG_URL ?? '').trim().replace(/\/+$/, '');

  constructor(private readonly i18n: I18nService) {}

  get enabled(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Отпечатать страницу в PDF (A4). Поля передаются ПАРАМЕТРАМИ Gotenberg, а не
   * только CSS `@page`: нативные колонтитулы Chromium (номера страниц) рисуются
   * именно в полях из параметров — с preferCssPageSize их бы не было.
   */
  async htmlToPdf(
    html: string,
    opts?: {
      footer?: 'none' | 'pageNumbers';
      /**
       * Язык КОЛОНТИТУЛА — это язык БУМАГИ, а не зрителя: «стр. 2 из 7» печатается
       * внутри документа и живёт в нём вечно. Обязателен вместе с колонтитулом.
       */
      language?: Locale;
    },
  ): Promise<Buffer> {
    if (!this.enabled) throw new Error('the PDF render is off (GOTENBERG_URL is not set)');

    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    // A4 в дюймах; поля ГОСТ-подобные: верх/низ/лево 20 мм, право 10 мм
    form.append('paperWidth', '8.27');
    form.append('paperHeight', '11.7');
    form.append('marginTop', '0.79');
    form.append('marginBottom', '0.79');
    form.append('marginLeft', '0.79');
    form.append('marginRight', '0.39');
    form.append('printBackground', 'true');
    if (opts?.footer === 'pageNumbers') {
      // Пустая шапка обязательна: без header.html Chromium печатает дефолтную (дата+URL)
      form.append('files', new Blob(['<div></div>'], { type: 'text/html' }), 'header.html');
      // Порядок слов в «стр. N из M» принадлежит ЯЗЫКУ, поэтому строку собирает
      // каталог, а спаны-счётчики Chromium уезжают в неё параметрами.
      const pageLabel = this.i18n.translateFor(opts.language ?? SOURCE_LOCALE, 'templates.print.pageOf', {
        page: '<span class="pageNumber"></span>',
        total: '<span class="totalPages"></span>',
      });
      form.append(
        'files',
        new Blob(
          [
            `<div style="font-size:9px;width:100%;text-align:center;font-family:'PT Serif','Liberation Serif',serif;color:#000;">` +
              `${pageLabel}</div>`,
          ],
          { type: 'text/html' },
        ),
        'footer.html',
      );
    }

    const res = await trustedFetch(
      `${this.baseUrl}/forms/chromium/convert/html`,
      { method: 'POST', body: form },
      { timeoutMs: 60_000, origin: 'env' },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gotenberg ${res.status}: ${text.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
