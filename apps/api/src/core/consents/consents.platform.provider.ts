import { Controller, Get, Injectable, OnModuleInit } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONSENT_DOCUMENT_KEYS,
  CONSENT_KINDS,
  SUPPORTED_LOCALES,
  consentsAttestInputSchema,
  consentsDraftSaveInputSchema,
  consentsPublishInputSchema,
  consentsReattestInputSchema,
  pdIncidentOpenInputSchema,
  pdIncidentStepInputSchema,
  type ConsentLocalizedText,
  type ConsentsAttestInput,
  type ConsentsDraftSaveInput,
  type ConsentsPublishInput,
  type ConsentsReattestInput,
  type PdIncidentDto,
  type PdIncidentOpenInput,
  type PlatformConsentsDocumentsDto,
  type PdIncidentStepInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { DryRun } from '../../shared/context/dry-run.context';
import { PlatformCapability, PlatformRoute } from '../../shared/decorators/platform.decorator';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { FilesService } from '../files/files.service';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { PlatformNotifier } from '../platform/platform.notifications';
import { SignRegistry } from '../sign/sign.registry';
import { SignService } from '../sign/sign.service';
import { PdfRenderService } from '../templates/pdf-render.service';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsIncidentsService } from './consents.incidents.service';
import { ConsentsService } from './consents.service';
import { ConsentsGateService } from './gate/consents-gate.service';
import { appTmpPath } from '../../shared/fs/temp-file.util';

export const CONSENT_VERSION_SIGN_REF = 'consent_version';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Команды и панели кабинета платформы (журнал, step-up, «четыре глаза» — исполнитель кабинета):
 *  - `consents.document.draft.save` (medium) — единственный черновик документа;
 *  - `consents.document.publish` (critical, dualControl, step-up, причина) — публикация с датой
 *    вступления; срочная (`urgent`) — с причиной не короче `urgentReasonMin`;
 *  - `consents.document.attest` (high) — заверение версии ЭЦП руководителя через core/sign;
 *  - `consents.versions.reattest` (critical, dualControl) — переподписать версии после
 *    компрометации ключа подписи (старая подпись остаётся в истории);
 *  - `pd.incident.open|notify_authority|notify_subjects|close` (critical, step-up) — журнал инцидентов.
 * Панель «Согласия» карточки 360 человека; общие чтения (документы, охват, инциденты) — контроллер ниже.
 */
@Injectable()
export class ConsentsPlatformProvider implements OnModuleInit {
  /** Пропуска «право отправить на подпись подтверждено командой кабинета»: `${actorId}:${versionId}` */
  private readonly attestPasses = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly notifier: PlatformNotifier,
    private readonly documents: ConsentsDocumentsService,
    private readonly consents: ConsentsService,
    private readonly incidents: ConsentsIncidentsService,
    private readonly gate: ConsentsGateService,
    private readonly signRegistry: SignRegistry,
    private readonly sign: SignService,
    private readonly files: FilesService,
    private readonly pdf: PdfRenderService,
  ) {}

  onModuleInit(): void {
    this.registerSignProvider();
    this.registerDocumentCommands();
    this.registerIncidentCommands();

    this.panels.register({
      key: 'user.consents',
      entity: 'user',
      titleKey: 'platform.panels.userConsents',
      capability: 'consents.read',
      order: 70,
      eager: false,
      load: async (_actor, id) => this.consents.summaryForUser(id),
    });
  }

  // ------------------------------------------------------------
  // Документы
  // ------------------------------------------------------------

  private registerDocumentCommands(): void {
    this.commands.register<ConsentsDraftSaveInput>({
      key: 'consents.document.draft.save',
      version: 1,
      group: 'consents',
      titleKey: 'platform.commands.consentsDocumentDraftSave.title',
      descriptionKey: 'platform.commands.consentsDocumentDraftSave.description',
      input: consentsDraftSaveInputSchema,
      capability: 'consents.write',
      risk: 'medium',
      // Тексты документов в журнал кабинета не дублируются — там только факт и номер версии
      redact: ['bodies', 'summaries', 'changeSummary'],
      target: (i) => ({ type: 'consent_document', id: i.documentKey }),
      execute: async (ctx, input, tx) => {
        const res = await this.documents.saveDraft(tx, ctx.actor.userId, input);
        return { result: res };
      },
    });

    this.commands.register<ConsentsPublishInput>({
      key: 'consents.document.publish',
      version: 1,
      group: 'consents',
      titleKey: 'platform.commands.consentsDocumentPublish.title',
      descriptionKey: 'platform.commands.consentsDocumentPublish.description',
      input: consentsPublishInputSchema,
      capability: 'consents.write',
      risk: 'critical',
      dualControl: true,
      stepUp: true,
      reasonRequired: true,
      target: (i) => ({ type: 'consent_document', id: i.documentKey }),
      execute: async (ctx, input, tx) => {
        const res = await this.documents.publish(tx, { userId: ctx.actor.userId, reason: ctx.reason }, input);
        return {
          after: { version: res.version, effectiveFrom: res.effectiveFrom.toISOString(), manifestHash: res.manifestHash, urgent: !!input.urgent, withdrawn: res.withdrawn },
          result: { versionId: res.versionId, version: res.version, effectiveFrom: res.effectiveFrom.toISOString() },
          // Микрокэш версий — эффект вне базы: после коммита, и не в предпросмотре
          afterCommit: async () => this.gate.invalidate(),
        };
      },
    });

    this.commands.register<ConsentsReattestInput>({
      key: 'consents.versions.reattest',
      version: 1,
      group: 'consents',
      titleKey: 'platform.commands.consentsVersionsReattest.title',
      descriptionKey: 'platform.commands.consentsVersionsReattest.description',
      input: consentsReattestInputSchema,
      capability: 'consents.write',
      risk: 'critical',
      dualControl: true,
      target: (i) => ({ type: 'signing_key', id: i.kid ?? 'consents' }),
      execute: async (_ctx, input, tx) => {
        const res = await this.documents.reattest(tx, input.kid ?? null);
        return { result: res, afterCommit: async () => this.documents.flushVerifyCache() };
      },
    });

    this.commands.register<ConsentsAttestInput>({
      key: 'consents.document.attest',
      version: 1,
      group: 'consents',
      titleKey: 'platform.commands.consentsDocumentAttest.title',
      descriptionKey: 'platform.commands.consentsDocumentAttest.description',
      input: consentsAttestInputSchema,
      capability: 'consents.write',
      risk: 'high',
      target: (i) => ({ type: 'consent_version', id: i.versionId }),
      execute: async (ctx, input) => {
        // Файл и заявка на подпись — эффекты вне транзакции команды: в предпросмотре молчат
        if (DryRun.active()) return { result: { preview: true } };
        return { result: await this.attest(ctx.actor.userId, input) };
      },
    });
  }

  // ------------------------------------------------------------
  // Заверение ЭЦП руководителя (необязательное) — core/sign
  // ------------------------------------------------------------

  private registerSignProvider(): void {
    this.signRegistry.register(CONSENT_VERSION_SIGN_REF, {
      resolveSubject: async (refId) => {
        const v = await this.db.consentVersion.findUnique({ where: { id: refId }, select: { status: true, documentKey: true, version: true, attestationFileId: true, publishedById: true } });
        if (!v || v.status === 'draft' || !v.attestationFileId) return null;
        const file = await this.db.fileObject.findUnique({ where: { id: v.attestationFileId }, select: { ownerId: true } });
        if (!file) return null;
        // Документ платформы — вне организаций; замороженная копия числится за тем, кто завёл заверение
        return { fileId: v.attestationFileId, title: `${v.documentKey} v${v.version}`, workspaceId: null, ownerType: 'user', ownerId: file.ownerId };
      },
      // Продуктовой двери «отправить версию на подпись» нет: право подтверждает ТОЛЬКО команда
      // кабинета (способность + step-up + журнал), оставляя одноразовый пропуск на время вызова
      canRequestSign: async (userId, refId) => this.attestPasses.has(`${userId}:${refId}`),
      canView: async () => false,
      describeForVerify: async (refId) => {
        const v = await this.db.consentVersion.findUnique({ where: { id: refId }, select: { documentKey: true, version: true } });
        return v ? { title: `${v.documentKey} v${v.version}`, kindLabel: null, orgLabel: null } : null;
      },
      onActFinished: async (refId, info) => {
        if (info.outcome !== 'signed' || !info.requestCompleted) return;
        await this.db.consentVersion.updateMany({ where: { id: refId, attestationSignRequestId: null }, data: { attestationSignRequestId: info.requestId } });
        this.documents.flushVerifyCache();
      },
    });
  }

  private async attest(actorId: string, input: ConsentsAttestInput): Promise<{ signRequestId: string }> {
    const row = await this.documents.loadVerified(input.versionId);
    if (row.attestationSignRequestId) throw badRequest('consents.alreadyAttested');
    const signer = await this.db.user.findUnique({ where: { id: input.signerUserId }, select: { id: true, kind: true, deletedAt: true } });
    if (!signer || signer.deletedAt || signer.kind !== 'person') throw notFound('auth.accountNotFound');

    const bodies = row.bodies as unknown as ConsentLocalizedText;
    const summaries = row.summaries as unknown as ConsentLocalizedText;
    const hashes = row.hashes as unknown as ConsentLocalizedText;
    // Бумага заверения — технический отпечаток: три языка подряд, хэши и манифест. Слова интерфейса
    // в неё не попадают (только сам юридический текст), поэтому каталог здесь не нужен.
    const sections = SUPPORTED_LOCALES.map(
      (l) => `<section><h2>${l.toUpperCase()} · sha256 ${hashes[l]}</h2><pre>${esc(summaries[l])}</pre><pre>${esc(bodies[l])}</pre></section>`,
    ).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:serif;font-size:11pt}pre{white-space:pre-wrap;font-family:inherit}h1{font-size:14pt}h2{font-size:10pt;word-break:break-all}section{page-break-before:always}</style></head><body><h1>${esc(row.documentKey)} · v${row.version}</h1><p>manifest sha256 ${row.manifestHash}</p><p>effective ${row.effectiveFrom!.toISOString()}</p>${sections}</body></html>`;
    let buffer: Buffer;
    try {
      buffer = await this.pdf.htmlToPdf(html, { footer: 'none' });
    } catch {
      throw badRequest('consents.pdfUnavailable');
    }
    const tmp = appTmpPath(`consent-${randomUUID()}.pdf`);
    await fs.writeFile(tmp, buffer);
    try {
      const file = await this.files.ingestLocalFile({ path: tmp, name: `${row.documentKey}-v${row.version}.pdf`, mime: 'application/pdf', profile: 'document', ownerUserId: actorId });
      await this.db.consentVersion.update({ where: { id: row.id }, data: { attestationFileId: file.id } });
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    const pass = `${actorId}:${row.id}`;
    this.attestPasses.add(pass);
    try {
      const request = await this.sign.createRequest(actorId, { refType: CONSENT_VERSION_SIGN_REF, refId: row.id, level: 'ecp', signerUserIds: [input.signerUserId] });
      return { signRequestId: (request as { id: string }).id };
    } finally {
      this.attestPasses.delete(pass);
    }
  }

  // ------------------------------------------------------------
  // Инциденты ПДн
  // ------------------------------------------------------------

  private registerIncidentCommands(): void {
    this.commands.register<PdIncidentOpenInput>({
      key: 'pd.incident.open',
      version: 1,
      group: 'consents',
      titleKey: 'platform.commands.pdIncidentOpen.title',
      descriptionKey: 'platform.commands.pdIncidentOpen.description',
      input: pdIncidentOpenInputSchema,
      capability: 'pd.incidents.write',
      risk: 'critical',
      stepUp: true,
      target: () => ({ type: 'pd_incident', id: 'new' }),
      execute: async (ctx, input, tx) => {
        const incident = await this.incidents.open(tx, ctx.actor.userId, input);
        // Тревога владельцам — в той же транзакции (outbox уведомлений): открыт = все знают
        await this.notifier.securityAlert(tx, ctx.actor.userId, 'pdIncidentOpened', `${incident.kind} · ${incident.notifyDeadlineAt.toISOString()}`);
        return { result: { incidentId: incident.id, notifyDeadlineAt: incident.notifyDeadlineAt.toISOString() } };
      },
    });

    const step = (key: string, camel: string, run: (tx: Parameters<ConsentsIncidentsService['close']>[0], actorId: string, input: PdIncidentStepInput) => Promise<{ id: string; status: string }>) =>
      this.commands.register<PdIncidentStepInput>({
        key,
        version: 1,
        group: 'consents',
        titleKey: `platform.commands.${camel}.title`,
        descriptionKey: `platform.commands.${camel}.description`,
        input: pdIncidentStepInputSchema,
        capability: 'pd.incidents.write',
        risk: 'critical',
        stepUp: true,
        target: (i) => ({ type: 'pd_incident', id: i.incidentId }),
        execute: async (ctx, input, tx) => {
          const row = await run(tx, ctx.actor.userId, input);
          return { after: { status: row.status }, result: { incidentId: row.id, status: row.status } };
        },
      });
    step('pd.incident.notify_authority', 'pdIncidentNotifyAuthority', (tx, actorId, i) => this.incidents.notifyAuthority(tx, actorId, i.incidentId, i.note ?? null));
    step('pd.incident.notify_subjects', 'pdIncidentNotifySubjects', (tx, actorId, i) => this.incidents.notifySubjects(tx, actorId, i.incidentId, i.note ?? null));
    step('pd.incident.close', 'pdIncidentClose', (tx, actorId, i) => this.incidents.close(tx, actorId, i.incidentId, i.note ?? null));
  }
}

/** Общие чтения движка для кабинета (не карточка сущности): документы с охватом принятия и журнал инцидентов. */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/consents')
export class ConsentsPlatformController {
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: ConsentsDocumentsService,
    private readonly incidents: ConsentsIncidentsService,
    private readonly gate: ConsentsGateService,
  ) {}

  @PlatformCapability('consents.read')
  @Get('documents')
  @ApiOperation({ summary: 'Every version of every document (no text) and the acceptance coverage of the current versions' })
  async listDocuments(): Promise<{ success: true; data: PlatformConsentsDocumentsDto }> {
    const [versions, published, livePeople, liveWorkspaces, byVersion] = await Promise.all([
      this.documents.listAll(),
      this.gate.publishedVersions(),
      this.db.user.count({ where: { kind: 'person', deletedAt: null, deletionScheduledAt: null } }),
      this.db.workspace.count({ where: { archivedAt: null } }),
      this.db.consentAcceptance.groupBy({ by: ['versionId'], where: { revokedAt: null }, _count: { _all: true } }),
    ]);
    const counts = new Map(byVersion.map((r) => [r.versionId, r._count._all]));
    const coverage = CONSENT_DOCUMENT_KEYS.filter((k) => CONSENT_KINDS[k].hasDocument).map((key) => {
      const current = this.gate.currentOf(published, key);
      return {
        documentKey: key,
        subject: CONSENT_KINDS[key].subject,
        currentVersion: current?.version ?? null,
        accepted: current ? counts.get(current.id) ?? 0 : 0,
        population: CONSENT_KINDS[key].subject === 'user' ? livePeople : liveWorkspaces,
      };
    });
    return { success: true, data: { versions, coverage } };
  }

  @PlatformCapability('pd.incidents.read')
  @Get('incidents')
  @ApiOperation({ summary: 'Personal data incident register with the notification deadlines' })
  async listIncidents(): Promise<{ success: true; data: PdIncidentDto[] }> {
    return { success: true, data: await this.incidents.list() };
  }
}
