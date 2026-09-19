import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONSENT_TEXT_DOCUMENT_KEYS, SUPPORTED_LOCALES, assertConsentRegistry, type ConsentDocumentKey, type ConsentLocalizedText } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsGateService } from './gate/consents-gate.service';

const SUMMARY_MARK = '<!-- summary -->';
const BODY_MARK = '<!-- body -->';

/**
 * Засев текстов документов. Исходники — `apps/api/consents-texts/<документ>.<язык>.md`
 * (markdown, две секции: `<!-- summary -->` и `<!-- body -->`, реквизиты оператора —
 * подстановками `{{legalName}}` и т.д.). Это ЗАГОТОВКИ под вычитку юристом: в базе из них
 * заводится ТОЛЬКО черновик версии 1 и только если у документа нет ни одной версии —
 * дальше единственный источник текста — база (правка и публикация через кабинет).
 *
 * development/test: черновик v1 публикуется сразу (иначе регистрация локально закрыта).
 * production: черновик ждёт вычитки и публикации командой кабинета («четыре глаза» + step-up);
 * пока обязательные документы пакета не опубликованы, регистрация и создание организаций
 * отвечают отказом — согласие задним числом не появляется (fail-closed).
 */
@Injectable()
export class ConsentsSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConsentsSeedService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly documents: ConsentsDocumentsService,
    private readonly gate: ConsentsGateService,
  ) {}

  private textsDir(): string | null {
    // dist/core/consents → apps/api ; src/core/consents (ts-node) → apps/api
    const candidates = [resolve(__dirname, '../../../consents-texts'), resolve(process.cwd(), 'consents-texts'), resolve(process.cwd(), 'apps/api/consents-texts')];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  private read(dir: string, key: ConsentDocumentKey): { bodies: ConsentLocalizedText; summaries: ConsentLocalizedText } | null {
    const bodies = {} as ConsentLocalizedText;
    const summaries = {} as ConsentLocalizedText;
    for (const l of SUPPORTED_LOCALES) {
      const file = join(dir, `${key}.${l}.md`);
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const s = raw.indexOf(SUMMARY_MARK);
      const b = raw.indexOf(BODY_MARK);
      if (s < 0 || b < 0 || b < s) throw new Error(`consents seed: ${key}.${l}.md must contain "${SUMMARY_MARK}" followed by "${BODY_MARK}"`);
      summaries[l] = raw.slice(s + SUMMARY_MARK.length, b).trim();
      bodies[l] = raw.slice(b + BODY_MARK.length).trim();
      if (!summaries[l] || !bodies[l]) throw new Error(`consents seed: ${key}.${l}.md has an empty section`);
    }
    return { bodies, summaries };
  }

  async onApplicationBootstrap(): Promise<void> {
    // Смоук реестра: опечатка в пакете/виде роняет старт, а не всплывает отказом на регистрации
    assertConsentRegistry();
    try {
      await this.ensure();
    } catch (err) {
      this.logger.error(`consent documents seed failed: ${(err as Error).message}`);
      // В production падение засева не должно ронять API: документы публикуются из кабинета
      if (isDevEnv()) throw err;
    }
  }

  async ensure(): Promise<void> {
    const dir = this.textsDir();
    if (!dir) {
      this.logger.warn('consents-texts directory not found — document drafts are not seeded');
      return;
    }
    let changed = false;
    for (const key of CONSENT_TEXT_DOCUMENT_KEYS) {
      const exists = await this.db.consentVersion.count({ where: { documentKey: key } });
      if (exists === 0) {
        const texts = this.read(dir, key);
        if (!texts) {
          this.logger.warn(`consents seed: no text files for "${key}"`);
          continue;
        }
        try {
          await this.db.$transaction((tx) => this.documents.saveDraft(tx, null, { documentKey: key, bodies: texts.bodies, summaries: texts.summaries, material: true }));
          this.logger.log(`consent document "${key}": draft v1 seeded`);
        } catch (err) {
          // Соседний инстанс засеял первым (уникум черновика) — не ошибка
          this.logger.warn(`consents seed "${key}": ${(err as Error).message}`);
        }
      }
      if (!isDevEnv()) continue;
      const draftV1 = await this.db.consentVersion.findFirst({ where: { documentKey: key, status: 'draft', version: 1 }, select: { id: true } });
      if (!draftV1) continue;
      try {
        await this.db.$transaction((tx) => this.documents.publish(tx, { userId: null, reason: null }, { documentKey: key }));
        changed = true;
        this.logger.log(`consent document "${key}": v1 published (development)`);
      } catch (err) {
        this.logger.warn(`consents dev publish "${key}": ${(err as Error).message}`);
      }
    }
    if (changed) this.gate.invalidate();
  }
}
