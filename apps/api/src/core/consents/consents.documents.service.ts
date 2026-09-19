import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type ConsentVersion } from '@prisma/client';
import {
  CONSENT_BUNDLES,
  CONSENT_ERROR_CODES,
  CONSENT_KINDS,
  CONSENT_LIMITS,
  CONSENT_OPERATOR,
  CONSENT_OPERATOR_KEYS,
  CONSENT_TEXT_DOCUMENT_KEYS,
  SUPPORTED_LOCALES,
  fillConsentPlaceholders,
  type ConsentBundleDto,
  type ConsentBundleKey,
  type ConsentDocumentDto,
  type ConsentDocumentKey,
  type ConsentLocalizedText,
  type ConsentPlaceholderValues,
  type ConsentVersionRefDto,
  type ConsentVersionStatus,
  type ConsentsDraftSaveInput,
  type ConsentsPublishInput,
  type Locale,
  type PlatformConsentVersionDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ApiError, badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { JobsService } from '../jobs/jobs.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import { CONSENTS_JOBS } from './consents.constants';
import { consentContentHashes, consentManifestHash, consentSignaturePayload } from './consents.hash';
import { ConsentsGateService, type ConsentVersionLite } from './gate/consents-gate.service';

type Tx = Prisma.TransactionClient;

const VERIFY_CACHE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface PublishActor {
  userId: string | null;
  /** Причина команды кабинета — у срочной публикации становится `urgentReason` */
  reason: string | null;
}

/**
 * Документы платформы: черновик → публикация (хэши по языкам → манифест с цепочкой на
 * прошлую версию → подпись платформы аудиторией `consents`) → действующая версия по дате.
 *
 * Чтение — fail-closed: текст отдаётся только после пересчёта хэшей, манифеста и архивной
 * проверки подписи. Подмена в базе (в обход триггера неизменяемости) видна сразу — документ
 * перестаёт отдаваться (`503 consents.integrity`), а не тихо показывает чужой текст.
 */
@Injectable()
export class ConsentsDocumentsService {
  private readonly logger = new Logger(ConsentsDocumentsService.name);
  private readonly verified = new Map<string, { at: number; ok: boolean }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly gate: ConsentsGateService,
    private readonly signing: KeysSigningService,
    private readonly jobs: JobsService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Реквизиты оператора на языке документа: БИН, домен и почта — константы shared, наименование,
   * адрес и должность ответственного лица — слова каталога `consents.operator.*`.
   */
  operatorValues(locale: Locale): ConsentPlaceholderValues {
    return {
      legalName: this.i18n.translateFor(locale, CONSENT_OPERATOR_KEYS.legalName),
      bin: CONSENT_OPERATOR.bin,
      address: this.i18n.translateFor(locale, CONSENT_OPERATOR_KEYS.address),
      domain: CONSENT_OPERATOR.domain,
      privacyEmail: CONSENT_OPERATOR.privacyEmail,
      dpoTitle: this.i18n.translateFor(locale, CONSENT_OPERATOR_KEYS.dpoTitle),
    };
  }

  // ------------------------------------------------------------
  // Черновики
  // ------------------------------------------------------------

  /** Единственный черновик документа: создать (номер = последний + 1) или обновить. */
  async saveDraft(tx: Tx, actorId: string | null, input: ConsentsDraftSaveInput): Promise<{ versionId: string; version: number; created: boolean }> {
    const key = input.documentKey as ConsentDocumentKey;
    if (!CONSENT_KINDS[key]?.hasDocument) throw badRequest(CONSENT_ERROR_CODES.notFound);
    this.assertPlaceholders(input.bodies, input.summaries, input.changeSummary ?? null);
    // Сериализация по документу: два сохранения разом дали бы два черновика с одним номером
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`consents:doc:${key}`}))`;
    const data = {
      bodies: input.bodies as Prisma.InputJsonValue,
      summaries: input.summaries as Prisma.InputJsonValue,
      changeSummary: this.changeOrNull(input.changeSummary ?? null) ?? Prisma.JsonNull,
      material: input.material,
    };
    const draft = await tx.consentVersion.findFirst({ where: { documentKey: key, status: 'draft' }, select: { id: true, version: true } });
    if (draft) {
      // Правка — строго status-guarded: опубликованная версия сюда не попадёт даже гонкой
      const { count } = await tx.consentVersion.updateMany({ where: { id: draft.id, status: 'draft' }, data });
      if (count === 0) throw conflict(CONSENT_ERROR_CODES.immutable);
      return { versionId: draft.id, version: draft.version, created: false };
    }
    const last = await tx.consentVersion.aggregate({ where: { documentKey: key }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    const row = await tx.consentVersion.create({ data: { documentKey: key, version, status: 'draft', createdById: actorId, ...data, material: version === 1 ? true : input.material } });
    return { versionId: row.id, version, created: true };
  }

  private changeOrNull(change: ConsentLocalizedText | null): Prisma.InputJsonValue | null {
    if (!change) return null;
    return SUPPORTED_LOCALES.some((l) => change[l]?.trim()) ? (change as Prisma.InputJsonValue) : null;
  }

  /** Опечатка в `{{…}}` ловится на сохранении черновика, а не уезжает в опубликованный текст. */
  private assertPlaceholders(bodies: ConsentLocalizedText, summaries: ConsentLocalizedText, change: ConsentLocalizedText | null): void {
    try {
      for (const l of SUPPORTED_LOCALES) {
        const values = this.operatorValues(l);
        fillConsentPlaceholders(bodies[l], values);
        fillConsentPlaceholders(summaries[l], values);
        if (change?.[l]) fillConsentPlaceholders(change[l], values);
      }
    } catch (err) {
      throw badRequest('consents.unknownPlaceholder', { detail: (err as Error).message.slice(0, 120) });
    }
  }

  // ------------------------------------------------------------
  // Публикация
  // ------------------------------------------------------------

  /**
   * Черновик → опубликованная версия с датой вступления. Первая версия документа вступает
   * сразу (заменять нечего, и принимать её некому задним числом). Следующие — не раньше чем
   * через `defaultEffectiveInDays` (условия для организаций — `workspaceNoticeDays`);
   * раньше — только `urgent` с причиной (её несёт команда кабинета: dualControl + step-up).
   */
  async publish(tx: Tx, actor: PublishActor, input: ConsentsPublishInput): Promise<{ versionId: string; version: number; effectiveFrom: Date; manifestHash: string; withdrawn: number }> {
    const key = input.documentKey as ConsentDocumentKey;
    const kind = CONSENT_KINDS[key];
    if (!kind?.hasDocument) throw badRequest(CONSENT_ERROR_CODES.notFound);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`consents:doc:${key}`}))`;

    const draft = await tx.consentVersion.findFirst({ where: { documentKey: key, status: 'draft' } });
    if (!draft) throw notFound(CONSENT_ERROR_CODES.notFound);
    const published = await tx.consentVersion.findMany({
      where: { documentKey: key, status: { not: 'draft' } },
      select: { version: true, manifestHash: true, effectiveFrom: true },
      orderBy: { version: 'desc' },
    });
    const prev = published[0] ?? null;

    const now = new Date();
    const noticeDays = kind.subject === 'workspace' ? CONSENT_LIMITS.workspaceNoticeDays : CONSENT_LIMITS.defaultEffectiveInDays;
    let effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : prev ? new Date(now.getTime() + noticeDays * DAY_MS) : now;
    if (Number.isNaN(effectiveFrom.getTime())) throw badRequest(CONSENT_ERROR_CODES.effectiveInPast);
    // Небольшой допуск: «сейчас» из формы приходит на секунды раньше серверного «сейчас»
    if (effectiveFrom.getTime() < now.getTime() - 60_000) throw badRequest(CONSENT_ERROR_CODES.effectiveInPast);
    if (effectiveFrom < now) effectiveFrom = now;
    const tooSoon = !!prev && effectiveFrom.getTime() < now.getTime() + noticeDays * DAY_MS - 60_000;
    let urgentReason: string | null = null;
    if (tooSoon) {
      if (!input.urgent) throw badRequest(CONSENT_ERROR_CODES.urgentNeedsReason, { days: noticeDays });
      const reason = (actor.reason ?? '').trim();
      if (reason.length < CONSENT_LIMITS.urgentReasonMin) throw badRequest(CONSENT_ERROR_CODES.urgentNeedsReason, { days: noticeDays });
      urgentReason = reason;
    }
    // Ещё не вступившая версия того же документа ОТЗЫВАЕТСЯ новой публикацией (`withdrawn`): срочная
    // правка не ждёт, пока вступит плановая, а двух очередей «на будущее» у документа не бывает —
    // иначе действующей когда-нибудь стала бы версия, написанная раньше уже действующей.
    const withdrawn = await tx.consentVersion.updateMany({ where: { documentKey: key, status: 'published', effectiveFrom: { gt: now } }, data: { status: 'withdrawn' } });

    const bodies = this.fill(draft.bodies as unknown as ConsentLocalizedText);
    const summaries = this.fill(draft.summaries as unknown as ConsentLocalizedText);
    const rawChange = (draft.changeSummary as unknown as ConsentLocalizedText | null) ?? null;
    const changeSummary = rawChange ? this.fill(rawChange) : null;
    for (const l of SUPPORTED_LOCALES) {
      if (!bodies[l]?.trim() || !summaries[l]?.trim()) throw badRequest(CONSENT_ERROR_CODES.incompleteLocales);
      // «Что изменилось» обязательно у каждой версии, кроме первой: блокирующий экран начинается с него
      if (prev && !changeSummary?.[l]?.trim()) throw badRequest(CONSENT_ERROR_CODES.incompleteLocales);
    }

    const hashes = consentContentHashes(key, draft.version, { bodies, summaries, changeSummary });
    const material = draft.version === 1 ? true : draft.material;
    const manifestHash = consentManifestHash({ documentKey: key, version: draft.version, hashes, material, effectiveFrom: effectiveFrom.toISOString(), prevManifestHash: prev?.manifestHash ?? null });
    const signedAt = new Date();
    const { kid, sig } = await this.signing.signRaw('consents', consentSignaturePayload(manifestHash, signedAt));

    const { count } = await tx.consentVersion.updateMany({
      where: { id: draft.id, status: 'draft' },
      data: {
        status: 'published',
        bodies: bodies as unknown as Prisma.InputJsonValue,
        summaries: summaries as unknown as Prisma.InputJsonValue,
        changeSummary: (changeSummary as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        hashes: hashes as unknown as Prisma.InputJsonValue,
        manifestHash,
        prevManifestHash: prev?.manifestHash ?? null,
        material,
        effectiveFrom,
        urgentReason,
        signature: sig,
        signatureKid: kid,
        signedAt,
        publishedAt: now,
        publishedById: actor.userId,
      },
    });
    if (count === 0) throw conflict(CONSENT_ERROR_CODES.immutable);

    await this.jobs.enqueue(tx, { type: CONSENTS_JOBS.versionActivate, payload: { versionId: draft.id }, runAt: effectiveFrom, uniqueKey: `activate:${draft.id}` });
    // Уведомление о новой версии: людям — всем живым аккаунтам порциями; организациям — владельцу и админам
    if (prev && material && kind.mode !== 'opt_out') {
      await this.jobs.enqueue(tx, { type: CONSENTS_JOBS.newVersionFanout, payload: { versionId: draft.id, cursor: null }, uniqueKey: `notify:${draft.id}` });
    }
    return { versionId: draft.id, version: draft.version, effectiveFrom, manifestHash, withdrawn: withdrawn.count };
  }

  private fill(text: ConsentLocalizedText): ConsentLocalizedText {
    const out = {} as ConsentLocalizedText;
    for (const l of SUPPORTED_LOCALES) out[l] = fillConsentPlaceholders(text[l] ?? '', this.operatorValues(l));
    return out;
  }

  /**
   * Джоб в момент `effectiveFrom`: прошлые версии → `superseded`, отметка активации. Шлюз от
   * джоба НЕ зависит (его правда — даты), поэтому опоздание джоба ничего не ломает.
   */
  async activate(versionId: string): Promise<'activated' | 'too_early' | 'skipped'> {
    const v = await this.db.consentVersion.findUnique({ where: { id: versionId }, select: { id: true, documentKey: true, version: true, status: true, effectiveFrom: true, activatedAt: true } });
    if (!v || v.status === 'draft' || v.status === 'withdrawn' || !v.effectiveFrom) return 'skipped';
    if (v.effectiveFrom.getTime() > Date.now()) return 'too_early';
    await this.db.$transaction(async (tx) => {
      await tx.consentVersion.updateMany({ where: { documentKey: v.documentKey, status: 'published', version: { lt: v.version } }, data: { status: 'superseded' } });
      await tx.consentVersion.updateMany({ where: { id: v.id, activatedAt: null }, data: { activatedAt: new Date() } });
    });
    this.gate.invalidate();
    return 'activated';
  }

  // ------------------------------------------------------------
  // Чтение (с проверкой целостности)
  // ------------------------------------------------------------

  /** Пересчитать хэши и манифест, проверить подпись архивно. Результат кэшируется на минуту. */
  async verifyVersion(row: ConsentVersion, opts: { fresh?: boolean } = {}): Promise<boolean> {
    const hit = this.verified.get(row.id);
    if (!opts.fresh && hit && Date.now() - hit.at < VERIFY_CACHE_MS) return hit.ok;
    const ok = await this.verifyUncached(row);
    this.verified.set(row.id, { at: Date.now(), ok });
    if (this.verified.size > 500) this.verified.clear();
    return ok;
  }

  flushVerifyCache(): void {
    this.verified.clear();
  }

  private async verifyUncached(row: ConsentVersion): Promise<boolean> {
    try {
      if (row.status === 'draft' || !row.hashes || !row.manifestHash || !row.effectiveFrom || !row.signature || !row.signatureKid || !row.signedAt) return false;
      const stored = row.hashes as unknown as ConsentLocalizedText;
      const hashes = consentContentHashes(row.documentKey, row.version, {
        bodies: row.bodies as unknown as ConsentLocalizedText,
        summaries: row.summaries as unknown as ConsentLocalizedText,
        changeSummary: (row.changeSummary as unknown as ConsentLocalizedText | null) ?? null,
      });
      for (const l of SUPPORTED_LOCALES) {
        if (hashes[l] !== stored[l]) {
          this.logger.error(`INTEGRITY: consent version ${row.documentKey} v${row.version} — text hash mismatch (${l})`);
          return false;
        }
      }
      const manifest = consentManifestHash({ documentKey: row.documentKey, version: row.version, hashes, material: row.material, effectiveFrom: row.effectiveFrom.toISOString(), prevManifestHash: row.prevManifestHash });
      if (manifest !== row.manifestHash) {
        this.logger.error(`INTEGRITY: consent version ${row.documentKey} v${row.version} — manifest mismatch`);
        return false;
      }
      const res = await this.signing.verifyArchival('consents', { kid: row.signatureKid, data: consentSignaturePayload(manifest, row.signedAt), sig: row.signature, signedAt: row.signedAt });
      if (!res.ok) this.logger.error(`INTEGRITY: consent version ${row.documentKey} v${row.version} — signature rejected (${res.reason})`);
      return res.ok;
    } catch (err) {
      this.logger.error(`INTEGRITY: consent version ${row.id} — verification failed: ${(err as Error).message}`);
      return false;
    }
  }

  private integrityError(): ApiError {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: CONSENT_ERROR_CODES.integrity });
  }

  /** Строка версии, прошедшая проверку целостности (иначе — отказ). Черновики сюда не попадают. */
  async loadVerified(versionId: string, client: Pick<DatabaseService, 'consentVersion'> = this.db): Promise<ConsentVersion> {
    const row = await client.consentVersion.findUnique({ where: { id: versionId } });
    // Отозванная до вступления версия остаётся читаемой (её могли принять заранее — лист согласия обязан открываться)
    if (!row || row.status === 'draft') throw notFound(CONSENT_ERROR_CODES.notFound);
    if (!(await this.verifyVersion(row))) throw this.integrityError();
    return row;
  }

  toRef(v: Pick<ConsentVersion, 'id' | 'documentKey' | 'version' | 'status' | 'material' | 'effectiveFrom' | 'publishedAt'> | ConsentVersionLite): ConsentVersionRefDto {
    return {
      documentKey: v.documentKey as ConsentDocumentKey,
      versionId: v.id,
      version: v.version,
      status: v.status as ConsentVersionStatus,
      material: v.material,
      effectiveFrom: v.effectiveFrom!.toISOString(),
      publishedAt: v.publishedAt?.toISOString() ?? null,
    };
  }

  /** Документ на языке: действующая версия либо конкретный номер из архива. */
  async getDocument(key: ConsentDocumentKey, locale: Locale, version?: number): Promise<ConsentDocumentDto> {
    if (!CONSENT_KINDS[key]?.hasDocument) throw notFound(CONSENT_ERROR_CODES.notFound);
    const versions = await this.gate.publishedVersions();
    const current = this.gate.currentOf(versions, key);
    const lite = version === undefined ? current ?? this.firstUpcoming(versions, key) : versions.find((v) => v.documentKey === key && v.version === version) ?? null;
    if (!lite) throw notFound(CONSENT_ERROR_CODES.notFound);
    const row = await this.loadVerified(lite.id);
    return this.toDocument(row, locale, current?.id === row.id);
  }

  async getDocumentByVersionId(versionId: string, locale: Locale): Promise<ConsentDocumentDto> {
    const row = await this.loadVerified(versionId);
    const current = this.gate.currentOf(await this.gate.publishedVersions(), row.documentKey as ConsentDocumentKey);
    return this.toDocument(row, locale, current?.id === row.id);
  }

  /** Документ ещё ни разу не вступал в силу, но опубликован на будущее — витрина показывает его. */
  private firstUpcoming(versions: ConsentVersionLite[], key: ConsentDocumentKey): ConsentVersionLite | null {
    return this.gate.upcomingOf(versions, key).sort((a, b) => a.version - b.version)[0] ?? null;
  }

  private toDocument(row: ConsentVersion, locale: Locale, isCurrent: boolean): ConsentDocumentDto {
    const bodies = row.bodies as unknown as ConsentLocalizedText;
    const summaries = row.summaries as unknown as ConsentLocalizedText;
    const change = (row.changeSummary as unknown as ConsentLocalizedText | null) ?? null;
    const hashes = row.hashes as unknown as ConsentLocalizedText;
    return {
      ...this.toRef(row),
      locale,
      summary: summaries[locale],
      body: bodies[locale],
      changeSummary: change?.[locale]?.trim() ? change[locale] : null,
      contentHash: hashes[locale],
      manifestHash: row.manifestHash!,
      isCurrent,
      attested: !!row.attestationSignRequestId,
    };
  }

  /** Архив версий документа (новые сверху) — публичная витрина. */
  async listArchive(key: ConsentDocumentKey): Promise<ConsentVersionRefDto[]> {
    if (!CONSENT_KINDS[key]?.hasDocument) throw notFound(CONSENT_ERROR_CODES.notFound);
    const versions = await this.gate.publishedVersions();
    return versions.filter((v) => v.documentKey === key).sort((a, b) => b.version - a.version).map((v) => this.toRef(v));
  }

  /** Пакет: действующие версии обязательных и необязательных документов — любой клиент рисует одинаково. */
  async bundle(bundleKey: ConsentBundleKey): Promise<ConsentBundleDto> {
    const def = CONSENT_BUNDLES[bundleKey];
    const versions = await this.gate.publishedVersions();
    const pick = (keys: readonly ConsentDocumentKey[]) =>
      keys.map((k) => this.gate.currentOf(versions, k)).filter((v): v is ConsentVersionLite => !!v).map((v) => this.toRef(v));
    return { bundleKey, subject: def.subject, documents: pick(def.documents), optional: pick(def.optional) };
  }

  /**
   * Сверить то, что человеку ПОКАЗАЛИ, с действующими версиями пакета — ДО действия (до
   * отправки SMS на регистрации). Каждый обязательный документ пакета обязан быть среди
   * выбранных своей ДЕЙСТВУЮЩЕЙ версией; лишнее — только необязательные документы того же
   * пакета. Пакет без опубликованных документов закрывает действие (fail-closed).
   */
  async assertBundleSelection(bundleKey: ConsentBundleKey, selection: { versionIds: string[] } | null | undefined): Promise<void> {
    if (!(await this.bundleReady(bundleKey))) throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: 'consents.notPublished' });
    if (!selection?.versionIds?.length) throw badRequest(CONSENT_ERROR_CODES.required);
    const bundle = await this.bundle(bundleKey);
    const chosen = new Set(selection.versionIds);
    for (const d of bundle.documents) if (!chosen.has(d.versionId)) throw badRequest(CONSENT_ERROR_CODES.required);
    const allowed = new Set([...bundle.documents, ...bundle.optional].map((d) => d.versionId));
    for (const id of chosen) if (!allowed.has(id)) throw conflict(CONSENT_ERROR_CODES.versionMismatch);
  }

  /** Все ли обязательные документы пакета опубликованы и действуют (иначе действие закрыто — fail-closed). */
  async bundleReady(bundleKey: ConsentBundleKey): Promise<boolean> {
    const def = CONSENT_BUNDLES[bundleKey];
    const versions = await this.gate.publishedVersions();
    return def.documents.every((k) => !!this.gate.currentOf(versions, k));
  }

  // ------------------------------------------------------------
  // Перезаверение (компрометация ключа подписи)
  // ------------------------------------------------------------

  /**
   * Переподписать версии, чья подпись сделана версией ключа `kid` (или, без `kid`, все, чью
   * подпись архивная проверка отвергает как `compromised`). Текст сверяется с НЕЗАВИСИМЫМИ
   * якорями — хэшами в записях приёмки людей: версия, чьи приёмки несут другой хэш, не
   * перезаверяется (это уже не компрометация ключа, а подмена текста). Старая подпись
   * уходит в `signatureHistory`.
   */
  async reattest(tx: Tx, kid: string | null): Promise<{ reattested: string[]; refused: Array<{ versionId: string; reason: string }> }> {
    const rows = await tx.consentVersion.findMany({ where: { status: { not: 'draft' }, ...(kid ? { signatureKid: kid } : {}) }, orderBy: [{ documentKey: 'asc' }, { version: 'asc' }] });
    const reattested: string[] = [];
    const refused: Array<{ versionId: string; reason: string }> = [];
    for (const row of rows) {
      const stored = row.hashes as unknown as ConsentLocalizedText;
      const data = consentSignaturePayload(row.manifestHash!, row.signedAt!);
      const current = await this.signing.verifyArchival('consents', { kid: row.signatureKid!, data, sig: row.signature!, signedAt: row.signedAt! });
      if (current.ok) continue; // подпись в порядке — не трогаем
      if (current.reason !== 'compromised' && current.reason !== 'state') {
        refused.push({ versionId: row.id, reason: `signature_${current.reason}` });
        continue;
      }
      const hashes = consentContentHashes(row.documentKey, row.version, {
        bodies: row.bodies as unknown as ConsentLocalizedText,
        summaries: row.summaries as unknown as ConsentLocalizedText,
        changeSummary: (row.changeSummary as unknown as ConsentLocalizedText | null) ?? null,
      });
      const manifest = consentManifestHash({ documentKey: row.documentKey, version: row.version, hashes, material: row.material, effectiveFrom: row.effectiveFrom!.toISOString(), prevManifestHash: row.prevManifestHash });
      if (SUPPORTED_LOCALES.some((l) => hashes[l] !== stored[l]) || manifest !== row.manifestHash) {
        refused.push({ versionId: row.id, reason: 'text_mismatch' });
        continue;
      }
      const foreign = await tx.consentAcceptance.count({ where: { versionId: row.id, NOT: { OR: SUPPORTED_LOCALES.map((l) => ({ locale: l, contentHash: stored[l] })) } } });
      if (foreign > 0) {
        refused.push({ versionId: row.id, reason: 'acceptance_hash_mismatch' });
        continue;
      }
      const signedAt = new Date();
      const next = await this.signing.signRaw('consents', consentSignaturePayload(manifest, signedAt));
      const history = [...((row.signatureHistory as unknown as unknown[]) ?? []), { kid: row.signatureKid, signature: row.signature, signedAt: row.signedAt!.toISOString(), replacedAt: signedAt.toISOString() }];
      await tx.consentVersion.update({ where: { id: row.id }, data: { signature: next.sig, signatureKid: next.kid, signedAt, signatureHistory: history as unknown as Prisma.InputJsonValue } });
      reattested.push(row.id);
    }
    return { reattested, refused };
  }

  /** Список для кабинета: все версии всех документов без текста. */
  async listAll(): Promise<PlatformConsentVersionDto[]> {
    const rows = await this.db.consentVersion.findMany({
      select: { id: true, documentKey: true, version: true, status: true, material: true, effectiveFrom: true, publishedAt: true, urgentReason: true, signatureKid: true, attestationSignRequestId: true },
      orderBy: [{ documentKey: 'asc' }, { version: 'desc' }],
    });
    return rows
      .filter((r) => (CONSENT_TEXT_DOCUMENT_KEYS as string[]).includes(r.documentKey))
      .map((r) => ({
        documentKey: r.documentKey as ConsentDocumentKey,
        versionId: r.id,
        version: r.version,
        status: r.status as ConsentVersionStatus,
        material: r.material,
        effectiveFrom: (r.effectiveFrom ?? new Date(0)).toISOString(),
        publishedAt: r.publishedAt?.toISOString() ?? null,
        urgentReason: r.urgentReason,
        signatureKid: r.signatureKid,
        attested: !!r.attestationSignRequestId,
        hasDraft: r.status === 'draft',
      }));
  }
}
