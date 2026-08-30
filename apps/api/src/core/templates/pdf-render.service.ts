import { Injectable, Logger } from '@nestjs/common';
import { trustedFetch } from '../../shared/http';

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

  get enabled(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Отпечатать страницу в PDF (A4). Поля передаются ПАРАМЕТРАМИ Gotenberg, а не
   * только CSS `@page`: нативные колонтитулы Chromium (номера страниц) рисуются
   * именно в полях из параметров — с preferCssPageSize их бы не было.
   */
  async htmlToPdf(html: string, opts?: { footer?: 'none' | 'pageNumbers' }): Promise<Buffer> {
    if (!this.enabled) throw new Error('PDF-рендер выключен (GOTENBERG_URL не задан)');

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
      form.append(
        'files',
        new Blob(
          [
            `<div style="font-size:9px;width:100%;text-align:center;font-family:'PT Serif','Liberation Serif',serif;color:#000;">` +
              `стр. <span class="pageNumber"></span> из <span class="totalPages"></span></div>`,
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
