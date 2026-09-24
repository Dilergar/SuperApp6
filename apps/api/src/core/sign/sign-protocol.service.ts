import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { PassThrough } from 'node:stream';
import * as yazl from 'yazl';
import * as QRCode from 'qrcode';
import type { SignAct as PrismaSignAct, SignRequest as PrismaSignRequest } from '@prisma/client';
import { SIGN_LIMITS, maskIin, maskPhone, signCheckUrl } from '@superapp/shared';
import type { Formatters, Translator } from '@superapp/i18n';
import { ApiError, notFound } from '../../shared/errors/api-error';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { FilesService } from '../files/files.service';
import { PdfRenderService } from '../templates/pdf-render.service';
import { SignService, type SignActor } from './sign.service';

/**
 * Артефакты подписания: «Протокол подписания» (PDF) и ЭКСПОРТНЫЙ ПАКЕТ (ZIP).
 *
 * Пакет — прямое требование ст. 62 Цифрового кодекса: подписанный документ
 * обязан жить ВНЕ информационной системы, которая его подписала. Поэтому в
 * архив кладётся всё, чем подпись доказывается без нас: сам документ, контейнеры
 * CMS, квитанции OCSP и метки времени, протокол и манифест со ссылками проверки.
 *
 * Печатаем тем же Gotenberg, что и блочные документы: один печатающий движок на
 * платформу, а значит и один результат.
 */
@Injectable()
export class SignProtocolService {
  private readonly logger = new Logger(SignProtocolService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sign: SignService,
    private readonly files: FilesService,
    private readonly pdf: PdfRenderService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Слова и правила показа для артефактов ЗАЯВКИ — в языке ЗАПРОСА: протокол и
   * пакет собираются на лету тому, кто их попросил, и должны читаться им же.
   * Секунда во времени обязательна: для суда важен порядок событий.
   */
  private words(): { t: Translator; f: Formatters } {
    return { t: this.i18n.t, f: this.i18n.format() };
  }

  // ============================================================
  // Протокол подписания
  // ============================================================

  async buildProtocol(actor: SignActor, requestId: string): Promise<{ buffer: Buffer; fileName: string }> {
    const request = await this.loadForExport(actor, requestId);
    if (!this.pdf.enabled) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: 'sign.protocolUnavailable' });
    }
    const html = await this.protocolHtml(request);
    // Колонтитул — на языке САМОГО артефакта: протокол собирается в языке запроса
    const buffer = await this.pdf.htmlToPdf(html, { footer: 'pageNumbers', language: this.i18n.locale });
    const fileName = `${this.i18n.translate('sign.protocol.fileName', { title: request.refTitle })}.pdf`;
    return { buffer, fileName };
  }

  private async protocolHtml(request: ExportRow): Promise<string> {
    const { t, f } = this.words();
    const at = (d: Date | null) => (d ? f.dateTime(d, 'short', { seconds: true }) : t('common.labels.dash'));
    const dash = t('common.labels.dash');
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const signed = request.acts.filter((a) => a.status === 'signed');
    const first = signed[0];
    // QR ведёт на публичную проверку ПЕРВОЙ подписи; страница показывает все.
    const qrSvg = first
      ? await QRCode.toString(signCheckUrl(webUrl, first.id, first.checkToken), {
          type: 'svg',
          margin: 0,
          errorCorrectionLevel: 'M',
        })
      : '';

    const rows = signed
      .map((a) => {
        const cert = a.certSubjectIin
          ? `<div class="muted">${esc(
              t('sign.protocol.certLine', {
                iin: maskIin(a.certSubjectIin) ?? dash,
                serial: a.certSerial ?? dash,
              }),
            )}</div>
             <div class="muted">${esc(t('sign.protocol.issuerLine', { issuer: a.certIssuerCn ?? dash }))}</div>
             <div class="muted">${esc(
               t('sign.protocol.chainLine', {
                 chain: t(a.chainValid ? 'sign.protocol.chainOk' : 'sign.protocol.chainBad'),
                 ocsp: a.ocspStatus ?? t('sign.protocol.ocspUnchecked'),
               }),
             )}</div>`
          : `<div class="muted">${esc(
              // Маска номера — ОБЩАЯ (shared): своя рядом с общей выдала бы оригинал по сочетанию
              t('sign.protocol.pepLine', { phone: maskPhone(a.signerPhone) ?? dash }),
            )}</div>`;
        return `<tr>
          <td>
            <div class="strong">${esc(a.signerName)}</div>
            ${cert}
          </td>
          <td>${esc(t(`sign.level.${a.level}.short`))}<div class="muted">${esc(
            a.method ? t(`sign.method.${a.method}.title`) : dash,
          )}</div></td>
          <td>${esc(at(a.signedAt))}</td>
        </tr>`;
      })
      .join('');

    const events = await this.db.signActEvent.findMany({
      where: { actId: { in: request.acts.map((a) => a.id) } },
      orderBy: { id: 'asc' },
      take: SIGN_LIMITS.eventsPageSize,
    });
    const actNames = new Map(request.acts.map((a) => [a.id, a.signerName]));
    const eventRows = events
      .map(
        (e) =>
          `<tr><td>${esc(at(e.at))}</td><td>${esc(actNames.get(e.actId) ?? '')}</td><td>${esc(
            t.has(`sign.event.${e.type}`) ? t(`sign.event.${e.type}`) : e.type,
          )}</td><td class="mono">${esc(e.ip ?? '')}</td></tr>`,
      )
      .join('');

    return `<html><head><meta charset="utf-8"><style>
      @font-face { font-family:'PT Serif'; src:local('PT Serif'); }
      body { font-family:'PT Serif','Liberation Serif',serif; font-size:11pt; color:#000; }
      h1 { font-size:15pt; margin:0 0 4mm; }
      h2 { font-size:12pt; margin:6mm 0 2mm; }
      table { width:100%; border-collapse:collapse; margin-bottom:4mm; }
      th, td { border:0.4pt solid #000; padding:1.6mm 2mm; text-align:left; vertical-align:top; font-size:9.5pt; }
      th { background:#f0f0f0; }
      .muted { color:#333; font-size:8.5pt; }
      .strong { font-weight:bold; }
      .mono { font-family:'DejaVu Sans Mono',monospace; font-size:8pt; word-break:break-all; }
      .head { display:flex; justify-content:space-between; align-items:flex-start; gap:8mm; }
      .qr { width:28mm; height:28mm; }
      .hash { font-family:'DejaVu Sans Mono',monospace; font-size:8pt; word-break:break-all; }
    </style></head><body>
      <div class="head">
        <div>
          <h1>${esc(t('sign.protocol.title'))}</h1>
          <div>${esc(t('sign.protocol.document'))}: <span class="strong">${esc(request.refTitle)}</span></div>
          <div class="muted">${esc(t('sign.protocol.fingerprint'))}</div>
          <div class="hash">${esc(request.subjectSha256)}</div>
          <div class="muted">${esc(
            t('sign.protocol.requestLine', { id: request.id, at: at(request.createdAt) }),
          )}</div>
        </div>
        <div class="qr">${qrSvg}</div>
      </div>

      <h2>${esc(t('sign.protocol.signatures'))}</h2>
      <table><thead><tr><th>${esc(t('sign.protocol.colSigner'))}</th><th>${esc(
        t('sign.protocol.colKind'),
      )}</th><th>${esc(t('sign.protocol.colSignedAt'))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">${esc(t('sign.protocol.noSignatures'))}</td></tr>`}</tbody></table>

      <h2>${esc(t('sign.protocol.events'))}</h2>
      <table><thead><tr><th>${esc(t('sign.protocol.colAt'))}</th><th>${esc(
        t('sign.protocol.colSigner'),
      )}</th><th>${esc(t('sign.protocol.colEvent'))}</th><th>IP</th></tr></thead>
      <tbody>${eventRows}</tbody></table>

      <div class="muted">${esc(t('sign.protocol.footer', { url: `${webUrl}/check` }))}</div>
    </body></html>`;
  }

  // ============================================================
  // Экспортный пакет (ст. 62 ЦК)
  // ============================================================

  async buildExport(actor: SignActor, requestId: string): Promise<{ buffer: Buffer; fileName: string }> {
    const request = await this.loadForExport(actor, requestId);
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';

    const zip = new yazl.ZipFile();
    const out = new PassThrough();
    zip.outputStream.pipe(out);

    // 1) Сам документ — ЗАМОРОЖЕННАЯ копия, а не живой файл: в пакете должно
    //    лежать ровно то, подо что стоят подписи.
    const subjectFile = await this.db.fileObject.findUnique({
      where: { id: request.subjectFileId },
      select: { name: true },
    });
    const subjectBytes = await this.sign.subjectBytes(request.subjectFileId);
    zip.addBuffer(subjectBytes, `document/${sanitize(subjectFile?.name ?? 'document.pdf')}`);

    // 2) Контейнеры подписи и квитанции
    const manifestActs: ManifestAct[] = [];
    let index = 0;
    for (const act of request.acts.filter((a) => a.status === 'signed')) {
      index += 1;
      const files: Record<string, string> = {};
      if (act.cmsFileId) {
        const name = `signatures/signature-${index}.cms`;
        zip.addBuffer(await this.bytesOf(act.cmsFileId), name);
        files.cms = name;
      }
      if (act.ocspFileId) {
        const name = `signatures/ocsp-${index}.der`;
        zip.addBuffer(await this.bytesOf(act.ocspFileId), name);
        files.ocsp = name;
      }
      if (act.tspFileId) {
        const name = `signatures/tsp-${index}.der`;
        zip.addBuffer(await this.bytesOf(act.tspFileId), name);
        files.tsp = name;
      }
      manifestActs.push({
        actId: act.id,
        signer: act.signerName,
        iin: maskIin(act.certSubjectIin),
        level: act.level,
        method: act.method,
        signedAt: act.signedAt?.toISOString() ?? null,
        certSerial: act.certSerial,
        issuer: act.certIssuerCn,
        chainValid: act.chainValid,
        ocspStatus: act.ocspStatus,
        // Ссылка проверки — то, ради чего пакет и собирают: получатель обязан
        // уметь проверить подпись, не имея доступа к нашей системе.
        checkUrl: signCheckUrl(webUrl, act.id, act.checkToken),
        consentText: act.consentText,
        files,
      });
    }

    // 3) Протокол — если печать доступна. Недоступна — пакет всё равно полезен,
    //    и лучше отдать его без протокола, чем не отдать вовсе.
    if (this.pdf.enabled) {
      try {
        const html = await this.protocolHtml(request);
        zip.addBuffer(
          await this.pdf.htmlToPdf(html, { footer: 'pageNumbers', language: this.i18n.locale }),
          'protocol.pdf',
        );
      } catch (err) {
        this.logger.warn(`The signing log did not make it into the package: ${(err as Error).message}`);
      }
    }

    // 4) Манифест
    const manifest = {
      format: 'superapp6.sign.export/1',
      requestId: request.id,
      document: {
        title: request.refTitle,
        sha256: request.subjectSha256,
        file: `document/${sanitize(subjectFile?.name ?? 'document.pdf')}`,
      },
      level: request.level,
      createdAt: request.createdAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
      signatures: manifestActs,
      verify: `${webUrl}/check`,
      // Манифест читает ЧЕЛОВЕК на той стороне — примечание переводим в языке
      // запроса вместе с остальным пакетом.
      note: this.i18n.translate('sign.export.note'),
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');

    zip.end();
    const buffer = await streamToBuffer(out);
    if (buffer.length > SIGN_LIMITS.exportMaxBytes) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: 'sign.packageTooBig' });
    }
    const fileName = `${this.i18n.translate('sign.export.fileName', { title: request.refTitle })}.zip`;
    return { buffer, fileName };
  }

  private async bytesOf(fileId: string): Promise<Buffer> {
    const { result } = await this.files.openRawStream(fileId, null);
    return streamToBuffer(result.stream);
  }

  /**
   * Кто вправе забрать пакет: подписант, автор заявки или тот, кому потребитель
   * разрешил видеть предмет. Проверку делает движок — доказательства подписи
   * это не «файл в чате», у них своя планка.
   */
  private async loadForExport(actor: SignActor, requestId: string): Promise<ExportRow> {
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      include: { acts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) throw notFound('sign.requestNotFound');
    // Права переиспользуем у сервиса: одна планка на экран подписания и на экспорт.
    await this.sign.getFlow(actor, requestId);
    return request;
  }
}

interface ManifestAct {
  actId: string;
  signer: string;
  iin: string | null;
  level: string;
  method: string | null;
  signedAt: string | null;
  certSerial: string | null;
  issuer: string | null;
  chainValid: boolean | null;
  ocspStatus: string | null;
  checkUrl: string;
  consentText: string | null;
  files: Record<string, string>;
}

type ExportRow = PrismaSignRequest & { acts: PrismaSignAct[] };

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Имена внутри архива не должны уводить наружу папки (zip-slip) */
function sanitize(name: string): string {
  return name.replace(/[\\/]/g, '-').replace(/^\.+/, '_');
}
