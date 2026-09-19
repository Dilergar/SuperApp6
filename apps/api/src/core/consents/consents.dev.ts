import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CONSENT_TEXT_DOCUMENT_KEYS, SUPPORTED_LOCALES, pdIncidentOpenInputSchema, type ConsentDocumentKey, type ConsentLocalizedText } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { SkipConsentGate } from '../../shared/decorators/skip-consent-gate.decorator';
import { forbidden, notFound } from '../../shared/errors/api-error';
import { KeysSigningService } from '../keys/keys.signing.service';
import { consentSignaturePayload } from './consents.hash';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsIncidentsService } from './consents.incidents.service';
import { ConsentsJobs } from './consents.jobs';
import { ConsentsService } from './consents.service';
import { ConsentsGateService } from './gate/consents-gate.service';

const publishBody = z
  .object({
    documentKey: z.enum(CONSENT_TEXT_DOCUMENT_KEYS as [ConsentDocumentKey, ...ConsentDocumentKey[]]),
    /** Через сколько секунд версия вступает в силу (0 — сразу) */
    effectiveInSec: z.number().int().min(0).max(86_400).default(0),
    material: z.boolean().default(true),
  })
  .strict();
const versionBody = z.object({ versionId: z.string().uuid() }).strict();
const incidentBody = z.object({ incidentId: z.string().uuid() }).strict();

/**
 * Дев-полигон движка согласий (только development/test, регистрируется модулем лишь в dev):
 * публикация новой версии за секунды вместо «четырёх глаз» и десяти дней, сброс кэшей,
 * проверка подписи двумя способами (строгая и архивная), тревога инцидента без ожидания.
 * Вне шлюза согласий: учение публикует версию, которая самого тестирующего и блокирует.
 */
@ApiTags('Consents')
@ApiBearerAuth()
@SkipConsentGate()
@Controller('consents/dev')
export class ConsentsDevController {
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: ConsentsDocumentsService,
    private readonly gate: ConsentsGateService,
    private readonly signing: KeysSigningService,
    private readonly incidents: ConsentsIncidentsService,
    private readonly jobs: ConsentsJobs,
    private readonly consents: ConsentsService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Clone the current version into a draft and publish it with a custom effective date' })
  async publish(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = publishBody.parse(body ?? {});
    const current = this.gate.currentOf(await this.gate.publishedVersions(), dto.documentKey);
    if (!current) throw notFound('consents.notFound');
    const row = await this.documents.loadVerified(current.id);
    const stamp = new Date().toISOString();
    const mark = (t: ConsentLocalizedText): ConsentLocalizedText => {
      const out = {} as ConsentLocalizedText;
      for (const l of SUPPORTED_LOCALES) out[l] = `${t[l]}\n\n[dev drill ${stamp}]`;
      return out;
    };
    const note = {} as ConsentLocalizedText;
    for (const l of SUPPORTED_LOCALES) note[l] = `dev drill ${stamp}`;
    const res = await this.db.$transaction(async (tx) => {
      await this.documents.saveDraft(tx, user.sub, {
        documentKey: dto.documentKey,
        bodies: mark(row.bodies as unknown as ConsentLocalizedText),
        summaries: row.summaries as unknown as ConsentLocalizedText,
        changeSummary: note,
        material: dto.material,
      });
      return this.documents.publish(
        tx,
        { userId: user.sub, reason: 'dev drill: accelerated publication for the verify suite' },
        { documentKey: dto.documentKey, effectiveFrom: new Date(Date.now() + dto.effectiveInSec * 1000).toISOString(), urgent: true },
      );
    });
    this.gate.invalidate();
    return { success: true, data: { versionId: res.versionId, version: res.version, effectiveFrom: res.effectiveFrom.toISOString() } };
  }

  @Post('flush')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Drop the in-process caches of the engine (versions, verification results)' })
  flush() {
    this.assertDev();
    this.gate.invalidate();
    this.documents.flushVerifyCache();
    return { success: true, data: { flushed: true } };
  }

  @Post('verify-signature')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Verify the platform signature of a version: strict (active key only) and archival' })
  async verifySignature(@Body() body: unknown) {
    this.assertDev();
    const { versionId } = versionBody.parse(body ?? {});
    const v = await this.db.consentVersion.findUnique({ where: { id: versionId } });
    if (!v || !v.manifestHash || !v.signature || !v.signatureKid || !v.signedAt) throw notFound('consents.notFound');
    const data = consentSignaturePayload(v.manifestHash, v.signedAt);
    const strict = await this.signing.verifyRaw('consents', v.signatureKid, data, v.signature);
    const archival = await this.signing.verifyArchival('consents', { kid: v.signatureKid, data, sig: v.signature, signedAt: v.signedAt });
    return { success: true, data: { kid: v.signatureKid, strict, archival: archival.ok, archivalReason: archival.reason ?? null, integrity: await this.documents.verifyVersion(v, { fresh: true }) } };
  }

  @Post('accept-outside-tx')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Guard drill: accepting outside a transaction must be refused by the engine' })
  async acceptOutsideTx(@CurrentUser() user: JwtPayload) {
    this.assertDev();
    try {
      // Намеренное нарушение: корневой клиент вместо транзакционного
      await this.consents.accept(this.db as never, { subject: { type: 'user', id: user.sub }, actorUserId: user.sub, actorRole: 'self', versionIds: ['00000000-0000-4000-8000-000000000000'], locale: 'en', channel: 'api', evidence: {} });
      return { success: true, data: { refused: false } };
    } catch (err) {
      return { success: true, data: { refused: /transaction client/.test((err as Error).message) } };
    }
  }

  @Post('reattest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Re-sign the versions whose signing key version is compromised or disabled (the console command without four eyes)' })
  async reattest() {
    this.assertDev();
    const res = await this.db.$transaction((tx) => this.documents.reattest(tx, null));
    this.documents.flushVerifyCache();
    return { success: true, data: res };
  }

  @Post('incident/open')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Open a PD incident without the console conveyor (deadline arithmetic drill)' })
  async openIncident(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = pdIncidentOpenInputSchema.parse(body ?? {});
    const incident = await this.db.$transaction((tx) => this.incidents.open(tx, user.sub, dto));
    return { success: true, data: this.incidents.toDto(incident) };
  }

  @Post('incident/alert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the deadline alert job of an incident now' })
  async alertIncident(@Body() body: unknown) {
    this.assertDev();
    const { incidentId } = incidentBody.parse(body ?? {});
    await this.jobs.incidentDeadlineAlert({ incidentId });
    const row = await this.db.pdIncident.findUnique({ where: { id: incidentId }, include: { events: true } });
    return { success: true, data: row ? this.incidents.toDto(row) : null };
  }

  @Post('incident/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Close a drill incident' })
  async closeIncident(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { incidentId } = incidentBody.parse(body ?? {});
    const row = await this.db.$transaction((tx) => this.incidents.close(tx, user.sub, incidentId, 'dev drill'));
    return { success: true, data: this.incidents.toDto(row) };
  }
}
