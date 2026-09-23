import { Injectable } from '@nestjs/common';
import { PD_RECIPIENTS, isPdRecipientKey } from '@superapp/shared';
import { resolveCountryValues, resolveLabelKeys, type Locale, type TranslationValues } from '@superapp/i18n';
import { I18nService } from '../../shared/i18n/i18n.service';

/** Что нужно рендеру одной строки (данные уже выбраны запросом). */
export interface AuditRenderSource {
  eventKey: string;
  details: Record<string, unknown>;
  op: string | null;
  targetLabel: string | null;
  country: string | null;
  /** Имя организации на момент ЧТЕНИЯ (переименование видно сразу; удалённая — слово-заглушка) */
  workspaceName: string | null;
  deviceLabel: string | null;
}

export interface AuditRendered {
  title: string;
  body: string | null;
}

/** Детали-коды, которые в тексте — слово продукта: код → ключ каталога под именем `<x>Key`. */
const ROLE_FIELDS: Array<[string, string]> = [
  ['role', 'roleLabel'],
  ['from', 'fromLabel'],
  ['to', 'toLabel'],
];

/**
 * Текст события собирается ПРИ ЧТЕНИИ (render-at-read, docs/i18n.md) в языке зрителя: в БД —
 * ключ реестра и детали-коды, слова — `audit.events.<key>.title|body`. Роль — словом
 * `common.role.workspace.*`, назначение передачи ПДн — `consents.purposes.*`, документ —
 * `shell.consents.documents.*`, страна — именем на языке зрителя, организация — ТЕКУЩИМ
 * именем. Неизвестный ключ (строка из прошлой версии реестра) — сам ключ, не пустота.
 */
@Injectable()
export class AuditRenderer {
  constructor(private readonly i18n: I18nService) {}

  render(locale: Locale, src: AuditRenderSource): AuditRendered {
    const t = this.i18n.forLocale(locale);
    const titleKey = `audit.events.${src.eventKey}.title`;
    if (!t.has(titleKey)) return { title: src.eventKey, body: null };
    const d = src.details ?? {};
    const values: TranslationValues = {};
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = v;
    }
    for (const [code, label] of ROLE_FIELDS) {
      if (typeof d[code] === 'string') values[`${label}Key`] = `common.role.workspace.${d[code]}`;
    }
    if (typeof d.purpose === 'string') {
      delete values.purpose;
      values.purposeKey = `consents.purposes.${d.purpose}`;
    }
    if (typeof d.document === 'string') {
      delete values.document;
      values.documentKey = `shell.consents.documents.${d.document}`;
    }
    if (typeof d.recipient === 'string') values.recipient = isPdRecipientKey(d.recipient) ? PD_RECIPIENTS[d.recipient].name : d.recipient;
    values.workspace = src.workspaceName ?? t('audit.unknownWorkspace');
    values.target = src.targetLabel ?? '';
    values.op = src.op ?? '';
    values.device = src.deviceLabel ?? t('audit.unknownDevice');
    if (src.country) values.whereCountry = src.country;
    const fmt = this.i18n.format(locale);
    const resolved = resolveLabelKeys(t, resolveCountryValues(fmt, values));
    const title = t(titleKey, resolved);
    const bodyKey = `audit.events.${src.eventKey}.body`;
    const body = t.has(bodyKey) ? t(bodyKey, resolved).trim() : '';
    return { title, body: body.length ? body : null };
  }
}
