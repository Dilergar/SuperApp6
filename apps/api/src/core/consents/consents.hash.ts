import { createHash } from 'node:crypto';
import { SUPPORTED_LOCALES, type ConsentLocalizedText, type Locale } from '@superapp/shared';
import { CONSENT_SIGNATURE_PREFIX } from './consents.constants';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Поля с префиксом длины: склейка не даёт двум разным наборам частей одну строку. */
const frame = (parts: string[]): string => parts.map((p) => `${p.length}:${p}`).join('|');

/**
 * Хэш ТОГО, ЧТО ВИДИТ ЧЕЛОВЕК на одном языке: «Коротко о главном», полный текст и
 * «Что изменилось». Ключ документа, номер версии и язык входят в хэш: текст нельзя
 * «перенести» в другую версию или выдать перевод за оригинал.
 */
export function consentContentHash(documentKey: string, version: number, locale: Locale, parts: { summary: string; body: string; changeSummary: string | null }): string {
  return sha256(frame(['v1', documentKey, String(version), locale, parts.summary, parts.body, parts.changeSummary ?? '']));
}

export function consentContentHashes(
  documentKey: string,
  version: number,
  texts: { bodies: ConsentLocalizedText; summaries: ConsentLocalizedText; changeSummary: ConsentLocalizedText | null },
): ConsentLocalizedText {
  const out = {} as ConsentLocalizedText;
  for (const l of SUPPORTED_LOCALES) {
    out[l] = consentContentHash(documentKey, version, l, { summary: texts.summaries[l], body: texts.bodies[l], changeSummary: texts.changeSummary?.[l] ?? null });
  }
  return out;
}

export interface ConsentManifest {
  documentKey: string;
  version: number;
  hashes: ConsentLocalizedText;
  material: boolean;
  effectiveFrom: string;
  prevManifestHash: string | null;
}

/** Манифест версии — канонический JSON с фиксированным порядком ключей (не зависит от движка JSON). */
export function consentManifestHash(m: ConsentManifest): string {
  const canonical = JSON.stringify([
    ['documentKey', m.documentKey],
    ['version', m.version],
    ['hashes', SUPPORTED_LOCALES.map((l) => [l, m.hashes[l]])],
    ['material', m.material],
    ['effectiveFrom', m.effectiveFrom],
    ['prevManifestHash', m.prevManifestHash],
  ]);
  return sha256(canonical);
}

/**
 * Строка под подпись платформы. Момент подписи ВХОДИТ в подписанное: архивная проверка
 * сверяет его с окном жизни версии ключа, и поправить `signed_at` в базе, не сломав
 * подпись, нельзя.
 */
export function consentSignaturePayload(manifestHash: string, signedAt: Date): string {
  return `${CONSENT_SIGNATURE_PREFIX}|${manifestHash}|${signedAt.toISOString()}`;
}
