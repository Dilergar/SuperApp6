import { CONSENT_KINDS, type ConsentDocumentKey, type ConsentSubjectType } from './registry';

// ============================================================
// Пакеты согласий: одна галочка = несколько документов
// ============================================================
// Клик по галочке пишет по записи приёмки НА КАЖДЫЙ документ пакета с общим `bundleKey`:
// доказательство остаётся подокументным (версия, хэш, язык), а человек видит одно действие.

export interface ConsentBundleDef {
  subject: ConsentSubjectType;
  /** Обязательные документы пакета — без них действие не состоится */
  documents: readonly ConsentDocumentKey[];
  /** Необязательные документы того же экрана (отдельные галочки, не блокируют) */
  optional: readonly ConsentDocumentKey[];
}

export function defineConsentBundles<const T extends Record<string, ConsentBundleDef>>(defs: T): T {
  return defs;
}

export const CONSENT_BUNDLES = defineConsentBundles({
  /** Регистрация: галочка № 1 — четыре документа (блокирует), галочка № 2 — `marketing` (не блокирует) */
  registration: { subject: 'user', documents: ['terms', 'privacy', 'cross_border', 'privacy_policy'], optional: ['marketing'] },
  /** Создание организации: одна галочка владельца */
  workspace_creation: { subject: 'workspace', documents: ['business_terms', 'dpa'], optional: [] },
});

export type ConsentBundleKey = keyof typeof CONSENT_BUNDLES;
export const CONSENT_BUNDLE_KEYS = Object.keys(CONSENT_BUNDLES) as ConsentBundleKey[];

export function isConsentBundleKey(value: unknown): value is ConsentBundleKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONSENT_BUNDLES, value);
}

/**
 * Смоук реестра (зовётся на bootstrap API): пакет ссылается только на существующие виды,
 * субъект документа совпадает с субъектом пакета, обязательные документы имеют текст,
 * а каждый `required`-вид входит хотя бы в один пакет (иначе его негде принять).
 */
export function assertConsentRegistry(): void {
  const inBundle = new Set<string>();
  for (const [bundleKey, bundle] of Object.entries(CONSENT_BUNDLES) as Array<[string, ConsentBundleDef]>) {
    for (const key of [...bundle.documents, ...bundle.optional]) {
      const kind = CONSENT_KINDS[key];
      if (!kind) throw new Error(`consents registry: bundle "${bundleKey}" references an unknown document "${key}"`);
      if (kind.subject !== bundle.subject) throw new Error(`consents registry: document "${key}" (${kind.subject}) does not match the subject of bundle "${bundleKey}" (${bundle.subject})`);
      if (!kind.hasDocument) throw new Error(`consents registry: document "${key}" of bundle "${bundleKey}" has no text`);
      inBundle.add(key);
    }
    for (const key of bundle.documents) {
      if (!CONSENT_KINDS[key].required) throw new Error(`consents registry: bundle "${bundleKey}" lists a non-required document "${key}" as mandatory`);
    }
    for (const key of bundle.optional) {
      if (CONSENT_KINDS[key].required) throw new Error(`consents registry: bundle "${bundleKey}" lists a required document "${key}" as optional`);
    }
  }
  for (const [key, kind] of Object.entries(CONSENT_KINDS)) {
    if (kind.required && !inBundle.has(key)) throw new Error(`consents registry: required document "${key}" is not part of any bundle`);
    if (kind.gate === 'block' && kind.subject !== 'user') throw new Error(`consents registry: document "${key}" — the blocking gate exists only for a person`);
    if (kind.gate === 'soft' && kind.subject !== 'workspace') throw new Error(`consents registry: document "${key}" — the soft gate exists only for an organization`);
    if (kind.gate !== 'none' && !kind.required) throw new Error(`consents registry: document "${key}" — only a required document may raise a gate`);
  }
}
