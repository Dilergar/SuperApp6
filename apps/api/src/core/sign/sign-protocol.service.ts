import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { PassThrough } from 'node:stream';
import * as yazl from 'yazl';
import * as QRCode from 'qrcode';
import type { SignAct as PrismaSignAct, SignRequest as PrismaSignRequest } from '@prisma/client';
import {
  SIGN_ACT_EVENT_LABELS,
  SIGN_LEVEL_LABELS,
  SIGN_LIMITS,
  SIGN_METHOD_LABELS,
  maskIin,
  signCheckUrl,
  type SignActEventType,
  type SignLevel,
  type SignMethod,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
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
  ) {}

  // ============================================================
  // Протокол подписания
  // ============================================================

  async buildProtocol(actor: SignActor, requestId: string): Promise<{ buffer: Buffer; fileName: string }> {
    const request = await this.loadForExport(actor, requestId);
    if (!this.pdf.enabled) {
      throw new ServiceUnavailableException('Печать протокола недоступна: PDF-рендер выключен');
    }
    const html = await this.protocolHtml(request);
    const buffer = await this.pdf.htmlToPdf(html, { footer: 'pageNumbers' });
    return { buffer, fileName: `Протокол подписания — ${request.refTitle}.pdf` };
  }

  private async protocolHtml(request: ExportRow): Promise<string> {
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
          ? `<div class="muted">ИИН ${maskIin(a.certSubjectIin)} · сертификат ${esc(a.certSerial ?? '—')}</div>
             <div class="muted">Издатель: ${esc(a.certIssuerCn ?? '—')}</div>
             <div class="muted">Цепочка: ${a.chainValid ? 'подтверждена' : 'НЕ подтверждена'} · статус на момент подписания: ${esc(a.ocspStatus ?? 'не проверялся')}</div>`
          : `<div class="muted">Простая электронная подпись — код подтверждён на номер ${esc(maskPhoneSafe(a.signerPhone))}</div>`;
        return `<tr>
          <td>
            <div class="strong">${esc(a.signerName)}</div>
            ${cert}
          </td>
          <td>${esc(SIGN_LEVEL_LABELS[a.level as SignLevel].short)}<div class="muted">${esc(
            a.method ? SIGN_METHOD_LABELS[a.method as SignMethod].title : '—',
          )}</div></td>
          <td>${esc(fmt(a.signedAt))}</td>
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
          `<tr><td>${esc(fmt(e.at))}</td><td>${esc(actNames.get(e.actId) ?? '')}</td><td>${esc(
            SIGN_ACT_EVENT_LABELS[e.type as SignActEventType] ?? e.type,
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
          <h1>Протокол подписания</h1>
          <div>Документ: <span class="strong">${esc(request.refTitle)}</span></div>
          <div class="muted">Отпечаток документа (SHA-256):</div>
          <div class="hash">${esc(request.subjectSha256)}</div>
          <div class="muted">Заявка № ${esc(request.id)} от ${esc(fmt(request.createdAt))}</div>
        </div>
        <div class="qr">${qrSvg}</div>
      </div>

      <h2>Подписи</h2>
      <table><thead><tr><th>Подписант</th><th>Вид подписи</th><th>Время подписания</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">Подписей нет</td></tr>'}</tbody></table>

      <h2>Протокол действий</h2>
      <table><thead><tr><th>Время</th><th>Подписант</th><th>Событие</th><th>IP</th></tr></thead>
      <tbody>${eventRows}</tbody></table>

      <div class="muted">
        Проверить подпись можно на открытой странице проверки: ${esc(webUrl)}/check — документ при проверке
        не покидает браузер, сверяется только его отпечаток (ст. 61 Цифрового кодекса Республики Казахстан).
      </div>
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
        zip.addBuffer(await this.pdf.htmlToPdf(html, { footer: 'pageNumbers' }), 'protocol.pdf');
      } catch (err) {
        this.logger.warn(`Протокол в пакет не попал: ${(err as Error).message}`);
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
      note:
        'Отпечаток документа считается по файлу из папки document/. ' +
        'Подписи можно проверить и сторонними средствами (eGov, ezSigner): контейнеры лежат в signatures/.',
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');

    zip.end();
    const buffer = await streamToBuffer(out);
    if (buffer.length > SIGN_LIMITS.exportMaxBytes) {
      throw new ServiceUnavailableException('Пакет слишком велик для одной выгрузки');
    }
    return { buffer, fileName: `Подписано — ${request.refTitle}.zip` };
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
    if (!request) throw new NotFoundException('Заявка на подпись не найдена');
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

function fmt(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: process.env.APP_TIMEZONE || 'Asia/Almaty',
  }).format(d);
}

function maskPhoneSafe(phone: string | null): string {
  if (!phone) return '—';
  return `${phone.slice(0, 6)}•••${phone.slice(-2)}`;
}

/** Имена внутри архива не должны уводить наружу папки (zip-slip) */
function sanitize(name: string): string {
  return name.replace(/[\\/]/g, '-').replace(/^\.+/, '_');
}
