import type { ConsentDocumentKey } from './registry';

// ============================================================
// Получатели персональных данных (третьи лица)
// ============================================================
// Единственный список тех, кому платформа передаёт ПДн. Из него собираются: перечень
// получателей в документе `cross_border`, раздел профиля «Кому передавались мои данные»
// и учёт действий (`PdActionRecord.recipientKey`). Новый внешний сервис = строка здесь
// + вызов `ConsentsActionsService.record(tx, …)` в месте фактической передачи — иначе
// передача останется без основания и без записи (ЗоПД ст. 7 п. 3, Правила № 179/НҚ п. 9 пп. 5).
//
// `name` — собственное имя юрлица/сервиса латиницей (не переводится; локализованное написание — в тексте документа). Цель для человека —
// ключ каталога `consents.recipients.<key>.purpose`.

/** Коды полей ПДн. В учёт действий пишутся ТОЛЬКО коды, никогда значения. */
export const PD_FIELD_CODES = [
  'phone',
  'first_name',
  'last_name',
  'middle_name',
  'avatar',
  'email',
  'date_of_birth',
  'city',
  'bio',
  'iin',
  'ip_address',
  'device_token',
  'notification_text',
  'calendar_events',
  'signature_certificate',
  'entity_payload',
  'public_card',
  'shared_content',
] as const;
export type PdFieldCode = (typeof PD_FIELD_CODES)[number];

/** Основание передачи (ЗоПД ст. 7, 9). `consent` требует живой приёмки документа `consentDocument`. */
export const PD_BASES = ['consent', 'subject_action', 'controller_instruction', 'legal_obligation'] as const;
export type PdBasis = (typeof PD_BASES)[number];

export interface PdRecipientDef {
  /** Собственное имя получателя */
  name: string;
  /** ISO 3166-1 alpha-2 страны получателя (`null` — определяется адресом получателя в момент передачи) */
  country: string | null;
  /** Передача за пределы РК (ЗоПД ст. 16) */
  crossBorder: boolean;
  /** Коды передаваемых полей */
  fields: readonly PdFieldCode[];
  basis: PdBasis;
  /** Документ-основание; у базовых получателей — `cross_border`/`privacy`, у «по запросу» — свой вид */
  consentDocument: ConsentDocumentKey | null;
  /** Базовый (нужен для работы платформы) или по запросу человека (интеграция) */
  tier: 'base' | 'on_demand';
  /** Передача уже происходит в продукте. `false` — получатель заявлен заранее, канал ещё не построен */
  active: boolean;
}

export function definePdRecipients<const T extends Record<string, PdRecipientDef>>(defs: T): T {
  return defs;
}

export const PD_RECIPIENTS = definePdRecipients({
  /** SMS-шлюз: коды подтверждения, служебные и критичные уведомления */
  kazinfoteh: { name: 'KazInfoTeh LLP', country: 'KZ', crossBorder: false, fields: ['phone', 'notification_text'], basis: 'consent', consentDocument: 'privacy', tier: 'base', active: true },
  /** Web push: службы доставки браузеров (FCM — Google, Mozilla autopush, Apple APNs, Microsoft WNS) */
  web_push: { name: 'Google FCM · Mozilla · Apple · Microsoft WNS', country: 'US', crossBorder: true, fields: ['device_token', 'notification_text', 'ip_address'], basis: 'consent', consentDocument: 'cross_border', tier: 'base', active: true },
  /** Синхронизация календаря — только после подключения человеком */
  google_calendar: { name: 'Google LLC (Google Calendar API)', country: 'US', crossBorder: true, fields: ['email', 'calendar_events'], basis: 'consent', consentDocument: 'integration_google', tier: 'on_demand', active: true },
  /** Почтовый провайдер: канал e-mail ещё не построен — получатель заявлен заранее */
  email_provider: { name: 'E-mail provider', country: null, crossBorder: false, fields: ['email', 'notification_text'], basis: 'consent', consentDocument: 'privacy', tier: 'base', active: false },
  /** Исходящий вебхук организации: адрес задаёт организация-собственник, платформа исполняет её поручение */
  webhook_subscriber: { name: 'Webhook endpoint of the organization', country: null, crossBorder: false, fields: ['entity_payload'], basis: 'controller_instruction', consentDocument: 'dpa', tier: 'on_demand', active: true },
  /** Проверка сертификата ЭЦП в Национальном удостоверяющем центре РК (OCSP/TSP) */
  ncanode: { name: 'NIT JSC — National Certification Authority of Kazakhstan (pki.gov.kz)', country: 'KZ', crossBorder: false, fields: ['signature_certificate', 'iin'], basis: 'subject_action', consentDocument: 'privacy', tier: 'on_demand', active: true },
});

export type PdRecipientKey = keyof typeof PD_RECIPIENTS;
export const PD_RECIPIENT_KEYS = Object.keys(PD_RECIPIENTS) as PdRecipientKey[];

export function isPdRecipientKey(value: unknown): value is PdRecipientKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PD_RECIPIENTS, value);
}
