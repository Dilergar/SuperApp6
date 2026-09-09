// ============================================================
// Платформенная библиотека кадровых бланков РК (КЭДО, Этап 3).
//
// Каталог живёт В КОДЕ, а не в БД: сменился ТК РК — правим здесь и предлагаем
// организациям «Обновить», а не чиним у 500 клиентов. Установка = мастер
// (спрашивает подписанта организации один раз) → вид + шаблон-конструктор +
// ОПУБЛИКОВАННЫЙ маршрут: маршрут-черновик, который менеджер забыл донастроить,
// — это действие, которое никогда не применится.
//
// Уровень подписи ЗАШИТ у платформенных бланков: приказы и трудовые договоры по
// ст. 11/33 ТК РК действительны электронно только с ЭЦП, и выбирать это руками
// на каждом маршруте — способ однажды забыть.
// ============================================================

import type { Locale } from '../constants/i18n';
import type { BuilderBlock, BuilderDoc, BuilderInline } from '../types/doc-builder';
import { DOC_BUILDER_VERSION } from '../types/doc-builder';

// ---------- Мини-конструкторы блоков (только для этого каталога) ----------

let seq = 0;
const bid = () => `lib${++seq}`;

const t = (text: string, styles?: { bold?: boolean; italic?: boolean }): BuilderInline => ({
  type: 'text',
  text,
  ...(styles ? { styles } : {}),
});
const chip = (path: string, format?: string): BuilderInline => ({
  type: 'chip',
  props: { path, ...(format ? { format } : {}) },
});

const p = (content: BuilderInline[], align?: 'left' | 'center' | 'right' | 'justify'): BuilderBlock => ({
  id: bid(),
  type: 'paragraph',
  ...(align ? { props: { align } } : {}),
  content,
});
const h = (text: string): BuilderBlock => ({
  id: bid(),
  type: 'heading',
  props: { level: 2, align: 'center' },
  content: [t(text)],
});
const requisites = (): BuilderBlock => ({ id: bid(), type: 'requisites', props: { showLogo: true } });
const docMeta = (): BuilderBlock => ({ id: bid(), type: 'docMeta', props: { align: 'left' } });
const sig = (
  role: string,
  nameSource: 'subject' | 'director' | 'custom' | 'none',
  stamp = false,
): BuilderBlock => ({ id: bid(), type: 'signature', props: { role, nameSource, stamp } });
const numbered = (text: BuilderInline[]): BuilderBlock => ({
  id: bid(),
  type: 'numberedListItem',
  content: text,
});

const doc = (blocks: BuilderBlock[]): BuilderDoc => ({
  version: DOC_BUILDER_VERSION,
  page: { footer: 'pageNumbers' },
  blocks,
});

// ---------- Типы каталога ----------

/**
 * Поле формы подачи библиотечного бланка. Слов не хранит: `key` — это ИМЯ ТЕГА
 * внутри бланка («{Form.LeavePeriod}»), а подпись, которую видит подающий,
 * живёт в каталоге под ключом `hr.library.item.<бланк>.field.<key>`.
 */
export interface HrLibraryFormField {
  key: string;
  kind: 'text' | 'textarea' | 'number' | 'date' | 'daterange' | 'select';
  required?: boolean;
}

/**
 * Декларативная схема маршрута библиотечного бланка. Реальные ноды собирает
 * мастер установки (hr-library.service): подписанта организации он спрашивает
 * один раз и проставляет во все маршруты.
 */
export interface HrLibraryRoute {
  /** Подпись работодателя (подписант из мастера установки; уровень = signatureLevel вида) */
  employerSign?: boolean;
  /** Подпись РАБОТНИКА — стороны документа (ЭЦП/ПЭП по уровню вида) */
  subjectSign?: boolean;
  /** Ознакомление работника (клик — ст. 23 п. 2 пп. 6 ТК РК) */
  subjectAck?: boolean;
  /** Согласование руководителя (заявления работника; решает подписант из мастера) */
  managerApproval?: boolean;
  /** Нода hr.apply — применить кадровое действие (виды-приказы кадровых действий) */
  hrApply?: boolean;
  /** Регистрация номера */
  register?: boolean;
  /** Подшить в дело */
  file?: boolean;
}

/**
 * Бланк библиотеки. СЛОВ здесь нет: название, описание, имя вида и имя шаблона
 * собираются по соглашению из каталога — `hr.library.item.<key>.{title,
 * description, docType, template}`. Название и описание человек читает НА ЭКРАНЕ
 * (мастер установки) — они в языке зрителя; имя вида и имя шаблона ложатся в БД
 * организации и печатаются рядом с бумагой — они в языке БЛАНКА.
 */
export interface HrLibraryItem {
  key: string;
  version: number;
  /**
   * ЯЗЫК БЛАНКА. Формулировки ТК РК записаны по-русски, поэтому и печатные слова
   * платформы внутри них («М.П.», «№ … от …», сумма прописью) обязаны быть
   * русскими. Перевод самой библиотеки на казахский — отдельный трек с
   * юридической вычиткой; крюк для него — это поле.
   */
  language: Locale;
  docType: {
    category: 'hr' | 'general';
    numberFormat: string;
    visibility: 'managers' | 'department' | 'team';
    signatureLevel: 'none' | 'pep' | 'ecp';
    toPersonalFile: boolean;
    specialDelivery?: boolean;
    retentionYears?: number;
  };
  template: {
    selfService: boolean;
    fields: HrLibraryFormField[];
  };
  builderDoc: BuilderDoc;
  route: HrLibraryRoute;
}

// ---------- Каталог ----------

/** Оговорка о форме документооборота — включается в договор (местная практика
 *  «по соглашению сторон»; отдельного согласия на переход на КЭДО в РК не требуется) */
const EDOC_CLAUSE =
  'Стороны договорились, что кадровые документы оформляются в электронной форме с использованием электронной цифровой подписи в информационной системе работодателя (ст. 11, 33 Трудового кодекса РК); по заявлению Работника отдельные документы оформляются на бумажном носителе.';

export const HR_LIBRARY: readonly HrLibraryItem[] = [
  {
    key: 'employment_contract',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ТД-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ТРУДОВОЙ ДОГОВОР'),
      docMeta(),
      p(
        [
          chip('Organization.LegalName'),
          t(' (БИН '),
          chip('Organization.Bin'),
          t('), именуемое далее «Работодатель», в лице директора '),
          chip('Organization.Director'),
          t(', действующего на основании '),
          chip('Organization.Ground'),
          t(', с одной стороны, и '),
          chip('Employee.FullName'),
          t(' (ИИН '),
          chip('Employee.Iin'),
          t('), именуемый(ая) далее «Работник», с другой стороны, заключили настоящий трудовой договор о нижеследующем:'),
        ],
        'justify',
      ),
      numbered([
        t('Работник принимается на работу на должность '),
        chip('Contract.Position'),
        t(', место работы: '),
        chip('Contract.Branch'),
        t('.'),
      ]),
      numbered([
        t('Дата начала работы: '),
        chip('Contract.StartDate', 'date'),
        t('. Срок договора: '),
        chip('Contract.Term'),
        t('.'),
      ]),
      numbered([
        t('Должностной оклад: '),
        chip('Contract.Salary', 'number'),
        t(' ('),
        chip('Contract.Salary', 'words'),
        t(') в месяц; ставка '),
        chip('Contract.Rate'),
        t('. Режим работы: '),
        chip('Contract.Schedule'),
        t('.'),
      ]),
      numbered([
        t('Испытательный срок: '),
        chip('Contract.ProbationUntil'),
        t('.'),
      ]),
      numbered([
        t(
          'Права и обязанности сторон, условия труда, оплата, отдых и ответственность определяются Трудовым кодексом РК и актами работодателя, с которыми Работник ознакомлен.',
        ),
      ]),
      numbered([t(EDOC_CLAUSE)]),
      p([]),
      sig('Работодатель, директор', 'director', true),
      sig('Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectSign: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'hire_order',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ПР-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о приёме на работу'),
      docMeta(),
      p(
        [
          t('Принять '),
          chip('Employee.FullName'),
          t(' (ИИН '),
          chip('Employee.Iin'),
          t(') на должность '),
          chip('Contract.Position'),
          t(' с '),
          chip('Action.EffectiveFrom', 'date'),
          t(' с должностным окладом '),
          chip('Contract.Salary', 'number'),
          t(' тенге ('),
          chip('Contract.Salary', 'words'),
          t(').'),
        ],
        'justify',
      ),
      p([t('Основание: трудовой договор № '), chip('Contract.Number'), t(' от '), chip('Contract.Date', 'date'), t('.')]),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'transfer_order',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ПР-П-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о переводе'),
      docMeta(),
      p(
        [
          t('Перевести '),
          chip('Employee.FullName'),
          t(' с должности '),
          chip('Contract.Position'),
          t(' на должность '),
          chip('Action.NewPosition'),
          t(' ('),
          chip('Action.NewBranch'),
          t(') с '),
          chip('Action.EffectiveFrom', 'date'),
          t('.'),
        ],
        'justify',
      ),
      p([t('Оклад с даты перевода: '), chip('Action.Salary', 'number'), t(' тенге ('), chip('Action.Salary', 'words'), t(').')]),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'salary_order',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ПР-ОТ-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ об изменении должностного оклада'),
      docMeta(),
      p(
        [
          t('Установить '),
          chip('Employee.FullName'),
          t(' ('),
          chip('Contract.Position'),
          t(') с '),
          chip('Action.EffectiveFrom', 'date'),
          t(' должностной оклад '),
          chip('Action.Salary', 'number'),
          t(' тенге ('),
          chip('Action.Salary', 'words'),
          t(') в месяц.'),
        ],
        'justify',
      ),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'leave_order',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ПР-О-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 5,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о предоставлении отпуска'),
      docMeta(),
      p(
        [
          t('Предоставить '),
          chip('Employee.FullName'),
          t(' ('),
          chip('Contract.Position'),
          t(') оплачиваемый ежегодный трудовой отпуск с '),
          chip('Action.EffectiveFrom', 'date'),
          t(' по '),
          chip('Action.EffectiveTo', 'date'),
          t(' продолжительностью '),
          chip('Action.Days'),
          t(' календарных дней.'),
        ],
        'justify',
      ),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'dismissal_order',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ПР-У-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      specialDelivery: true,
      retentionYears: 75,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о прекращении трудового договора'),
      docMeta(),
      p(
        [
          t('Прекратить действие трудового договора № '),
          chip('Contract.Number'),
          t(' от '),
          chip('Contract.Date', 'date'),
          t(': уволить '),
          chip('Employee.FullName'),
          t(' ('),
          chip('Contract.Position'),
          t(') '),
          chip('Action.EffectiveFrom', 'date'),
          t('. Основание: '),
          chip('Action.Ground'),
          t('.'),
        ],
        'justify',
      ),
      p([
        t('Бухгалтерии произвести окончательный расчёт не позднее трёх рабочих дней (ст. 113 п. 4 ТК РК); выдать документ о трудовой деятельности в день прекращения (ст. 62 ТК РК).'),
      ]),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'leave_application',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ЗАЯВ-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'pep',
      toPersonalFile: false,
      retentionYears: 5,
    },
    template: {
      selfService: true,
      fields: [{ key: 'LeavePeriod', kind: 'daterange', required: true }],
    },
    builderDoc: doc([
      p([t('Директору '), chip('Organization.LegalName')], 'right'),
      p([t('от '), chip('Employee.FullName'), t(' ('), chip('Contract.Position'), t(')')], 'right'),
      h('ЗАЯВЛЕНИЕ'),
      p(
        [
          t('Прошу предоставить мне оплачиваемый ежегодный трудовой отпуск '),
          chip('Form.LeavePeriod'),
          t(' ('),
          chip('Form.LeavePeriod Days'),
          t(' календарных дней).'),
        ],
        'justify',
      ),
      p([]),
      sig('Работник', 'subject'),
    ]),
    route: { managerApproval: true, register: true, file: true },
  },
  {
    key: 'resignation_application',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ЗАЯВ-У-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'pep',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: {
      selfService: true,
      fields: [{ key: 'DismissalDate', kind: 'date', required: true }],
    },
    builderDoc: doc([
      p([t('Директору '), chip('Organization.LegalName')], 'right'),
      p([t('от '), chip('Employee.FullName'), t(' ('), chip('Contract.Position'), t(')')], 'right'),
      h('ЗАЯВЛЕНИЕ'),
      p(
        [
          t('Прошу расторгнуть трудовой договор по моей инициативе (ст. 56 Трудового кодекса РК) '),
          chip('Form.DismissalDate', 'date'),
          t('.'),
        ],
        'justify',
      ),
      p([]),
      sig('Работник', 'subject'),
    ]),
    route: { managerApproval: true, register: true, file: true },
  },
  {
    key: 'pd_consent',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ПД-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'pep',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      h('СОГЛАСИЕ на сбор и обработку персональных данных'),
      docMeta(),
      p(
        [
          t('Я, '),
          chip('Employee.FullName'),
          t(' (ИИН '),
          chip('Employee.Iin'),
          t('), в соответствии с Законом РК «О персональных данных и их защите» даю согласие '),
          chip('Organization.LegalName'),
          t(' (БИН '),
          chip('Organization.Bin'),
          t(
            ') на сбор и обработку моих персональных данных в целях трудовых отношений: оформления кадровых документов, расчёта оплаты труда, исполнения обязанностей работодателя по законодательству РК, включая передачу сведений в государственные системы учёта трудовых договоров.',
          ),
        ],
        'justify',
      ),
      p([t('Согласие действует на период трудовых отношений и сроки хранения кадровых документов, установленные законодательством РК. Согласие может быть отозвано письменным заявлением.')], 'justify'),
      p([]),
      sig('Работник', 'subject'),
    ]),
    route: { subjectSign: true, register: true, file: true },
  },
  {
    key: 'conditions_change_notice',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'УВ-{YYYY}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 5,
    },
    template: {
      selfService: false,
      fields: [
        { key: 'WhatChanges', kind: 'textarea', required: true },
        { key: 'ChangeDate', kind: 'date', required: true },
      ],
    },
    builderDoc: doc([
      requisites(),
      h('УВЕДОМЛЕНИЕ об изменении условий труда'),
      docMeta(),
      p([chip('Employee.FullName'), t(' ('), chip('Contract.Position'), t(')')]),
      p(
        [
          t('В соответствии со ст. 46 Трудового кодекса РК уведомляем об изменении условий труда с '),
          chip('Form.ChangeDate', 'date'),
          t(': '),
          chip('Form.WhatChanges'),
          t('.'),
        ],
        'justify',
      ),
      p(
        [
          t(
            'В случае письменного отказа от продолжения работы в изменённых условиях трудовой договор подлежит прекращению по пп. 2) п. 1 ст. 58 ТК РК.',
          ),
        ],
        'justify',
      ),
      p([]),
      sig('Директор', 'director', true),
      sig('Уведомление получил(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true },
  },
  {
    key: 'cybersecurity_policy',
    version: 1,
    language: 'ru',
    docType: {
      category: 'hr',
      numberFormat: 'ЛНА-{YYYY}-{NNN}',
      visibility: 'team',
      signatureLevel: 'none',
      toPersonalFile: false,
      retentionYears: 5,
    },
    template: { selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ТРЕБОВАНИЯ информационной безопасности для работников'),
      docMeta(),
      numbered([t('Использовать служебные учётные записи только для рабочих задач; пароли не передавать никому, включая коллег и руководителей.')]),
      numbered([t('Не открывать вложения и ссылки из неожиданных писем; о подозрительных сообщениях немедленно сообщать ответственному за информационную безопасность.')]),
      numbered([t('Не устанавливать на рабочие устройства постороннее программное обеспечение; не подключать личные носители без проверки.')]),
      numbered([t('Персональные данные и служебную информацию не передавать третьим лицам и не выносить за пределы информационных систем работодателя.')]),
      numbered([t('Об утере устройств, компрометации паролей и инцидентах информационной безопасности сообщать незамедлительно: работодатель обязан уведомить об инциденте в течение 1 рабочего дня.')]),
      p([]),
      sig('Директор', 'director', true),
    ]),
    route: { employerSign: true, register: true, file: true },
  },
] as const;

export const HR_LIBRARY_MAP: Record<string, HrLibraryItem> = HR_LIBRARY.reduce(
  (acc, item) => ({ ...acc, [item.key]: item }),
  {} as Record<string, HrLibraryItem>,
);

/** Библиотечный ключ приказа для вида кадрового действия (модалка предлагает шаблон сама) */
export const HR_ACTION_ORDER_LIBRARY_KEY: Record<string, string> = {
  hire: 'hire_order',
  transfer: 'transfer_order',
  salary_change: 'salary_order',
  leave: 'leave_order',
  dismissal: 'dismissal_order',
};
