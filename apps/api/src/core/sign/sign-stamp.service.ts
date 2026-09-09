import { Injectable, Logger } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import * as fontkitNs from '@pdf-lib/fontkit';
import * as QRCode from 'qrcode';
import { SIGN_FILE_PROFILES, SIGN_REQUEST_REF_TYPE, maskIin, maskPhone, signCheckUrl } from '@superapp/shared';
import type { Formatters, Locale, Translator } from '@superapp/i18n';
import type { SignAct as PrismaSignAct, SignRequest as PrismaSignRequest } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { FilesService } from '../files/files.service';
import { JobDiscardError } from '../jobs/jobs.registry';
import { withTempFile } from '../../shared/fs/temp-file.util';

// UMD-сборка fontkit: default есть не во всех вариантах интеропа
const fontkit = ((fontkitNs as { default?: unknown }).default ?? fontkitNs) as Parameters<
  PDFDocument['registerFontkit']
>[0];

const PDF_MIME = 'application/pdf';
/** А4 в PDF-пунктах — размер «Листа подписей» */
const A4 = { w: 595.28, h: 841.89 } as const;

/**
 * ШТАМПОВАННАЯ копия подписанного документа (Doodocs-модель, рыночный стандарт
 * ЭДО): на каждой странице — полоса «подписано электронной подписью», последней
 * страницей — «Лист подписей» с именами, сертификатами, временем и QR-кодами
 * страницы проверки. Это ВИТРИНА для людей и бумажного оборота, НЕ доказательство:
 * доказательства — CMS и замороженная копия; штамп при потере пересобирается.
 *
 * Кириллица: pdf-lib без внешнего TTF печатает кракозябры (стандартные шрифты
 * PDF — латиница), поэтому шрифт всегда встраивается сабсетом — PT Serif из
 * infra/pdf-fonts (тот же, каким печатают Gotenberg и веб: один вид на платформу).
 */
@Injectable()
export class SignStampService {
  private readonly logger = new Logger(SignStampService.name);
  private fontCache: { regular: Buffer; bold: Buffer } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Язык штампа — язык ОТПРАВИТЕЛЯ заявки (`User.locale` автора). У джоба
   * запроса нет, а штамп ложится в базу файлом и идёт в бумажный оборот
   * владельца документа: его языком он и говорит. Копия при этом объявлена
   * пересобираемой витриной, поэтому смена языка автора здесь не катастрофа —
   * доказательства (CMS, замороженная копия, протокол) от неё не зависят.
   */
  private words(locale: Locale): { t: Translator; f: Formatters } {
    return { t: this.i18n.forLocale(locale), f: this.i18n.format(locale) };
  }

  /**
   * Собрать штампованную копию заявки. Идемпотентно по `stampedFileId`; не-PDF
   * предмет (текстовые заглушки дев-полигона) пропускается без инцидента.
   */
  async build(requestId: string): Promise<void> {
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      include: { acts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) throw new JobDiscardError('the signing request is gone');
    if (request.status !== 'completed') return; // заявку успели закрыть иначе — штамповать нечего
    if (request.stampedFileId) {
      if (await this.fileAlive(request.stampedFileId)) return; // уже собрано (повтор джоба)
      // Файл забрала уборка (или он умер вместе с местом): указатель врёт —
      // `stamped.ready` обещает копию, которой нет. Обнуляем и пересобираем: штамп
      // и заявлен как пересобираемая витрина, а не как доказательство.
      this.logger.warn(`request ${requestId}: the stamped copy is gone — rebuilding it`);
      await this.db.signRequest.updateMany({
        where: { id: request.id, stampedFileId: request.stampedFileId },
        data: { stampedFileId: null, stampedSha256: null },
      });
    }

    const subject = await this.db.fileObject.findUnique({
      where: { id: request.subjectFileId },
      select: { mime: true, name: true },
    });
    if (!subject) throw new JobDiscardError('the frozen copy of the subject is gone');
    if (subject.mime !== PDF_MIME) {
      // Штампуется только PDF: предмет другого формата — не ошибка конвейера,
      // а свойство потребителя (дев-полигон морозит текст).
      this.logger.log(`request ${requestId}: the subject is ${subject.mime} — no stamp is built`);
      return;
    }

    const signed = request.acts.filter((a) => a.status === 'signed');
    if (signed.length === 0) return;

    const fonts = await this.loadFonts();
    const bytes = await this.subjectBytes(request.subjectFileId);

    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch (e) {
      throw new JobDiscardError(`the subject PDF cannot be opened: ${(e as Error).message}`);
    }
    pdf.registerFontkit(fontkit);
    const regular = await pdf.embedFont(fonts.regular, { subset: true });
    const bold = await pdf.embedFont(fonts.bold, { subset: true });

    const webUrl = (process.env.WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const words = this.words(await this.i18n.localeOf(request.createdById));
    this.stampPages(pdf, regular, request, signed, webUrl, words);
    await this.appendSignaturesSheet(pdf, regular, bold, request, signed, webUrl, words);

    const out = Buffer.from(await pdf.save());
    const name = `${words.t('sign.stamp.fileName', { title: request.refTitle })}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
    const file = await withTempFile(name, out, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name,
        mime: PDF_MIME,
        profile: SIGN_FILE_PROFILES.stamped,
        ownerUserId: request.createdById,
        ownerType: request.workspaceId ? 'workspace' : 'user',
        ownerId: request.workspaceId ?? request.createdById,
      }),
    );

    // Клейм под гвардом: гонку двух заходов выигрывает один, второй прибирает
    // свой файл — иначе на квоте копился бы штамп-сирота на каждый ретрай.
    let lost = false;
    await this.db.$transaction(async (tx) => {
      const won = await tx.signRequest.updateMany({
        where: { id: request.id, stampedFileId: null },
        data: { stampedFileId: file.id, stampedSha256: file.sha256 ?? null },
      });
      if (won.count === 0) {
        lost = true;
        return;
      }
      await this.files.linkSystemInTx(tx, {
        fileId: file.id,
        refType: SIGN_REQUEST_REF_TYPE,
        refId: request.id,
        role: 'stamped',
        createdById: request.createdById,
      });
    });
    if (lost) {
      await this.files.systemDeleteFile(file.id).catch(() => undefined);
    }
  }

  // ============================================================
  // Полоса на каждой странице
  // ============================================================

  private stampPages(
    pdf: PDFDocument,
    font: PDFFont,
    request: PrismaSignRequest,
    signed: PrismaSignAct[],
    webUrl: string,
    { t }: { t: Translator },
  ): void {
    const names = signed.map((a) => a.signerName).join(', ');
    const line1 = this.fit(font, 6.5, t('sign.stamp.band', { signers: names }), 540);
    const line2 = this.fit(
      font,
      6.5,
      t('sign.stamp.bandCheck', { sha256: request.subjectSha256, url: `${webUrl}/check` }),
      540,
    );
    for (const page of pdf.getPages()) {
      const { width } = page.getSize();
      const bandH = 20;
      // Полоса живёт В НИЖНЕМ ПОЛЕ (ГОСТ-поля 20 мм ≈ 56 pt — места хватает),
      // полупрозрачная подложка не даёт тексту документа сделать её нечитаемой.
      page.drawRectangle({
        x: 8,
        y: 6,
        width: width - 16,
        height: bandH,
        color: rgb(1, 1, 1),
        opacity: 0.82,
        borderColor: rgb(0.35, 0.45, 0.62),
        borderWidth: 0.6,
        borderOpacity: 0.9,
      });
      page.drawText(line1, { x: 12, y: 6 + bandH - 8.5, size: 6.5, font, color: rgb(0.16, 0.22, 0.34) });
      page.drawText(line2, { x: 12, y: 6 + 3.4, size: 6.5, font, color: rgb(0.16, 0.22, 0.34) });
    }
  }

  // ============================================================
  // «Лист подписей»
  // ============================================================

  private async appendSignaturesSheet(
    pdf: PDFDocument,
    regular: PDFFont,
    bold: PDFFont,
    request: PrismaSignRequest,
    signed: PrismaSignAct[],
    webUrl: string,
    { t, f }: { t: Translator; f: Formatters },
  ): Promise<void> {
    const dash = t('common.labels.dash');
    const margin = 48;
    let page = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - margin;

    const text = (
      s: string,
      opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; dy?: number } = {},
    ) => {
      const size = opts.size ?? 9.5;
      page.drawText(this.fit(opts.font ?? regular, size, s, A4.w - margin * 2), {
        x: margin,
        y,
        size,
        font: opts.font ?? regular,
        color: opts.color ?? rgb(0, 0, 0),
      });
      y -= opts.dy ?? size + 5;
    };

    text(t('sign.stamp.sheetTitle'), { size: 16, font: bold, dy: 24 });
    text(t('sign.stamp.document', { title: request.refTitle }), { size: 10.5 });
    text(t('sign.stamp.fingerprint'), { size: 8.5, color: rgb(0.25, 0.25, 0.25) });
    text(request.subjectSha256, { size: 8.5, dy: 18 });

    for (const act of signed) {
      // Не влезает блок целиком — новая страница (лист может быть и вторым)
      if (y < margin + 120) {
        page = pdf.addPage([A4.w, A4.h]);
        y = A4.h - margin;
      }
      const blockTop = y;

      const qrPng = await QRCode.toDataURL(signCheckUrl(webUrl, act.id, act.checkToken), {
        margin: 0,
        width: 220,
        errorCorrectionLevel: 'M',
      });
      const qrImage = await pdf.embedPng(qrPng);
      const qrSize = 68;

      text(act.signerName, { size: 11, font: bold });
      const method = act.method ? t(`sign.method.${act.method}.title`) : null;
      text(`${t(`sign.level.${act.level}.full`)}${method ? ` · ${method}` : ''}`, {
        size: 8.5,
        color: rgb(0.2, 0.2, 0.2),
      });
      if (act.certSubjectIin) {
        text(
          `${t('sign.stamp.iin', { iin: maskIin(act.certSubjectIin) ?? dash })}${
            act.certSubjectBin ? ` · ${t('sign.stamp.bin', { bin: act.certSubjectBin })}` : ''
          }`,
          { size: 8.5 },
        );
        text(
          t('sign.stamp.certLine', { serial: act.certSerial ?? dash, issuer: act.certIssuerCn ?? dash }),
          { size: 8.5, color: rgb(0.2, 0.2, 0.2) },
        );
        text(
          t('sign.stamp.chainLine', {
            chain: t(act.chainValid ? 'sign.protocol.chainOk' : 'sign.protocol.chainBad'),
            ocsp: act.ocspStatus ?? dash,
          }),
          { size: 8.5, color: rgb(0.2, 0.2, 0.2) },
        );
      } else {
        text(t('sign.stamp.pepLine', { phone: maskPhone(act.signerPhone ?? '') || dash }), { size: 8.5 });
      }
      const signedAt = act.tspAt ?? act.signedAt;
      text(
        t('sign.stamp.signedAt', {
          at: signedAt ? f.dateTime(signedAt, 'short', { seconds: true }) : dash,
        }),
        { size: 8.5 },
      );

      // QR справа от блока — ведёт на публичную проверку ИМЕННО этого акта
      page.drawImage(qrImage, {
        x: A4.w - margin - qrSize,
        y: blockTop - qrSize + 10,
        width: qrSize,
        height: qrSize,
      });

      y = Math.min(y, blockTop - qrSize + 2);
      y -= 14;
      page.drawLine({
        start: { x: margin, y },
        end: { x: A4.w - margin, y },
        thickness: 0.5,
        color: rgb(0.75, 0.75, 0.75),
      });
      y -= 16;
    }

    if (y < margin + 40) {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - margin;
    }
    text(t('sign.stamp.footerCheck', { url: `${webUrl}/check` }), {
      size: 8,
      color: rgb(0.3, 0.3, 0.3),
    });
    text(t('sign.stamp.footerNotice'), { size: 8, color: rgb(0.3, 0.3, 0.3) });
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /** Урезать строку под ширину (шрифт «знает» ширину своих глифов) */
  private fit(font: PDFFont, size: number, s: string, maxWidth: number): string {
    // PDF-текст не терпит переводов строк и непечатаемых знаков WinAnsi
    let out = s.replace(/[\r\n\t]+/g, ' ');
    if (font.widthOfTextAtSize(out, size) <= maxWidth) return out;
    while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
      out = out.slice(0, -1);
    }
    return `${out}…`;
  }

  /** Файл ещё жив (не прибран уборкой) — иначе указатель на него врёт */
  private async fileAlive(fileId: string): Promise<boolean> {
    const row = await this.db.fileObject.findUnique({
      where: { id: fileId },
      select: { status: true },
    });
    return !!row && row.status !== 'deleted';
  }

  private async subjectBytes(fileId: string): Promise<Buffer> {
    const { result } = await this.files.openRawStream(fileId, null);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  /**
   * PT Serif из infra/pdf-fonts — тот же, каким печатают Gotenberg и веб (один
   * вид документа на платформу). Пути перебираются от cwd и от dist: рабочая
   * папка у dev-запуска и у собранного main.js разная.
   */
  private async loadFonts(): Promise<{ regular: Buffer; bold: Buffer }> {
    if (this.fontCache) return this.fontCache;
    const roots = [
      path.resolve(process.cwd(), 'infra/pdf-fonts'),
      path.resolve(process.cwd(), '../../infra/pdf-fonts'),
      path.resolve(__dirname, '../../../../infra/pdf-fonts'),
      path.resolve(__dirname, '../../../../../infra/pdf-fonts'),
    ];
    for (const root of roots) {
      try {
        const regular = await fsp.readFile(path.join(root, 'PTSerif-Regular.ttf'));
        const bold = await fsp.readFile(path.join(root, 'PTSerif-Bold.ttf'));
        this.fontCache = { regular, bold };
        return this.fontCache;
      } catch {
        // пробуем следующий корень
      }
    }
    // Без кириллического шрифта штамп выйдет кракозябрами — честный отказ без ретраев
    throw new JobDiscardError('the PT Serif fonts (infra/pdf-fonts) are missing — the stamp cannot be built');
  }
}
