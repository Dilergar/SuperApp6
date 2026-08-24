import { z } from 'zod';
import { SIGN_LEVELS, SIGN_LIMITS, SIGN_METHODS } from '../constants/sign';
import { VERIFY_LIMITS } from '../constants/verify';
import { APPROVAL_LIMITS } from '../constants/approvals';

// ============================================
// core/sign — Zod-схемы
// ============================================
// Тип входа рукой не пишется: `XxxInput = z.infer<…>` рядом со схемой, и его
// импортируют и сервис, и клиент («Контракт API ↔ клиенты»).

/**
 * refType — свободная строка, а не enum: движок не знает своих потребителей, и
 * закрытый список означал бы правку общего пакета на каждый новый сервис.
 * Незарегистрированный тип отсекает сам движок по реестру.
 */
const refType = z.string().trim().min(1).max(64);

/**
 * Подписантов на одну заявку — потолок СНИМКА шага согласований: шаг «нужен
 * каждый» на 200 адресатов заводит акты всем разом, и меньший потолок ронял бы
 * его на валидации. Больше снимка — это уже рассылка: ей место в кампаниях КЭДО.
 */
const SIGN_SIGNERS_MAX = APPROVAL_LIMITS.maxSnapshotSize;

const reason = z
  .string()
  .trim()
  .min(SIGN_LIMITS.declineReasonMinLength, 'Укажите причину отказа')
  .max(SIGN_LIMITS.declineReasonMaxLength)
  .refine((s) => !/[<>]/.test(s), 'Недопустимые символы');

/**
 * Согласие сторон об электронной подписи. `literal(true)` — не придирка: ПЭП
 * равнозначна собственноручной подписи ТОЛЬКО по соглашению сторон (ст. 47 ЦК),
 * поэтому «false» здесь не «выключенная опция», а отсутствие правового
 * основания подписывать.
 */
const consentAccepted = z.literal(true, {
  errorMap: () => ({ message: 'Подтвердите согласие на подписание' }),
});

/** ПОДПИСЬ по ПЭП, шаг 1: приняли соглашение → шлём код на подтверждённый номер */
export const signPepStartSchema = z
  .object({
    consentAccepted,
    /** Внешнему подписанту нужно ещё согласие на обработку ПД (ст. 8 ЗоПД) */
    pdConsentAccepted: z.boolean().optional(),
  })
  .strict();

/** ПОДПИСЬ по ПЭП, шаг 2: код из SMS */
export const signPepConfirmSchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z
      .string()
      .trim()
      .regex(new RegExp(`^\\d{${VERIFY_LIMITS.codeLength}}$`), 'Код состоит из 6 цифр'),
  })
  .strict();

/**
 * ПОДПИСЬ через NCALayer: браузер собрал CMS целиком и прислал готовый контейнер.
 * Уровень и метод отсюда НЕ принимаются — их назначает сервер по способу входа
 * (иначе ПЭП объявила бы себя ЭЦП одним полем в теле запроса).
 */
export const signCmsSchema = z
  .object({
    cms: z
      .string()
      .trim()
      .min(1, 'Пустой контейнер подписи')
      .max(Math.ceil((SIGN_LIMITS.maxCmsBytes * 4) / 3) + 64, 'Контейнер подписи слишком большой'),
    /** Соглашение принимается и при ЭЦП: событие `consent` обязано быть в протоколе */
    consentAccepted: consentAccepted.optional(),
    pdConsentAccepted: z.boolean().optional(),
  })
  .strict();

/** Отказ подписанта — тоже акт, и причина обязательна (как в approvals) */
export const signDeclineSchema = z
  .object({
    reason,
    /**
     * Куда двинуть маршрут. `returned` («на доработку») — мягкий исход: документ
     * вернётся автору. По умолчанию отказ жёсткий.
     */
    outcome: z.enum(['rejected', 'returned']).optional(),
  })
  .strict();

/** Старт QR-сессии eGov Mobile */
export const signQrStartSchema = z
  .object({
    consentAccepted: consentAccepted.optional(),
    pdConsentAccepted: z.boolean().optional(),
  })
  .strict();

/**
 * Публичная проверка (ст. 61 ЦК). Два входа:
 *  - по отпечатку файла: sha256 считает БРАУЗЕР, сам файл на сервер не уходит;
 *  - по токену из QR на протоколе подписания.
 */
export const signCheckQuerySchema = z
  .object({
    sha256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/i, 'Отпечаток — 64 шестнадцатеричных символа')
      .optional(),
    actId: z.string().uuid().optional(),
    /** checkToken из адреса `/check/:actId?k=…` */
    k: z.string().trim().min(8).max(128).optional(),
  })
  .strict()
  .refine((q) => !!q.sha256 || (!!q.actId && !!q.k), {
    message: 'Укажите отпечаток документа или ссылку проверки',
  });

/**
 * Заведение заявки на подпись потребителем. HTTP-ручки у неё НЕТ намеренно —
 * ровно тот же довод, по которому её нет у core/approvals: право «отправить это
 * на подпись» знает только потребитель, а публичный путь шёл бы мимо него.
 * Схема живёт здесь как ЕДИНСТВЕННОЕ описание формы входа сервисного вызова.
 */
export const createSignRequestSchema = z
  .object({
    refType,
    refId: z.string().uuid(),
    level: z.enum(SIGN_LEVELS),
    /** Пусто → движок сам возьмёт все способы, доступные этому уровню */
    methods: z.array(z.enum(SIGN_METHODS)).optional(),
    /** Шаг маршрута, который закроется подписью */
    approvalStepId: z.string().uuid().optional(),
    /** Кого зовём подписывать (внутренние подписанты) */
    signerUserIds: z.array(z.string().uuid()).max(SIGN_SIGNERS_MAX).optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();

/** Дев-полигон движка (только NODE_ENV=development) */
export const signDevRequestSchema = z
  .object({
    level: z.enum(SIGN_LEVELS),
    methods: z.array(z.enum(SIGN_METHODS)).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    /** Кого позвать подписывать помимо себя */
    signerUserIds: z.array(z.string().uuid()).max(10).optional(),
    /** Содержимое «документа» — текст, который движок заморозит как PDF-заглушку */
    body: z.string().max(10_000).optional(),
    /**
     * `body` — готовые байты PDF (ASCII): предмет получает mime application/pdf,
     * и сьют проверяет ШТАМП (не-PDF предметы джоб штампа честно пропускает).
     */
    pdf: z.boolean().optional(),
    /** Флаг «потребитель шлёт свои уведомления сам» — проверка подавления дублей */
    suppressOutcomeNotify: z.boolean().optional(),
  })
  .strict();

/**
 * Тело, которое присылает мост eGov Mobile на одноразовый signToken.
 *
 * Ручка ПУБЛИЧНАЯ (у телефона нет нашей сессии), поэтому потолок здесь — не
 * формальность: без него в base64-декод уходила строка любой длины. Имя поля у
 * моста между версиями разное, и все известные варианты описаны ЗДЕСЬ, а не
 * разбираются в контроллере: одно описание провода на оба конца.
 */
const cmsBase64 = z
  .string()
  .trim()
  .min(1)
  .max(Math.ceil((SIGN_LIMITS.maxCmsBytes * 4) / 3) + 64);

export const signQrSubmitSchema = z
  .object({
    cms: cmsBase64.optional(),
    signature: cmsBase64.optional(),
    cmsSignature: cmsBase64.optional(),
  })
  .passthrough()
  .transform((body) => body.cms ?? body.signature ?? body.cmsSignature ?? '')
  .refine((cms) => cms.length > 0, { message: 'Пустой контейнер подписи' });

export type SignPepStartInput = z.infer<typeof signPepStartSchema>;
export type SignPepConfirmInput = z.infer<typeof signPepConfirmSchema>;
export type SignCmsInput = z.infer<typeof signCmsSchema>;
export type SignDeclineInput = z.infer<typeof signDeclineSchema>;
export type SignQrStartInput = z.infer<typeof signQrStartSchema>;
export type SignCheckQuery = z.infer<typeof signCheckQuerySchema>;
export type CreateSignRequestInput = z.infer<typeof createSignRequestSchema>;
export type SignDevRequestInput = z.infer<typeof signDevRequestSchema>;
export type SignQrSubmitInput = z.infer<typeof signQrSubmitSchema>;
