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

export interface HrLibraryFormField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'date' | 'daterange' | 'select';
  required?: boolean;
  options?: { value: string; label: string }[];
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

export interface HrLibraryItem {
  key: string;
  version: number;
  title: string;
  description: string;
  docType: {
    name: string;
    category: 'hr' | 'general';
    numberFormat: string;
    visibility: 'managers' | 'department' | 'team';
    signatureLevel: 'none' | 'pep' | 'ecp';
    toPersonalFile: boolean;
    specialDelivery?: boolean;
    retentionYears?: number;
  };
  template: {
    name: string;
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
    title: 'Трудовой договор',
    description:
      'Бессрочный трудовой договор по ст. 28 ТК РК с оговоркой об электронном документообороте. Данные подставляются из трудовой карточки и анкеты сотрудника; подписывают обе стороны ЭЦП.',
    docType: {
      name: 'Трудовые договоры',
      category: 'hr',
      numberFormat: 'ТД-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { name: 'Трудовой договор', selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ТРУДОВОЙ ДОГОВОР'),
      docMeta(),
      p(
        [
          chip('Организация.Юрнаименование'),
          t(' (БИН '),
          chip('Организация.БИН'),
          t('), именуемое далее «Работодатель», в лице директора '),
          chip('Организация.Директор'),
          t(', действующего на основании '),
          chip('Организация.Основание'),
          t(', с одной стороны, и '),
          chip('Сотрудник.ФИО'),
          t(' (ИИН '),
          chip('Сотрудник.ИИН'),
          t('), именуемый(ая) далее «Работник», с другой стороны, заключили настоящий трудовой договор о нижеследующем:'),
        ],
        'justify',
      ),
      numbered([
        t('Работник принимается на работу на должность '),
        chip('Договор.Должность'),
        t(', место работы: '),
        chip('Договор.Филиал'),
        t('.'),
      ]),
      numbered([
        t('Дата начала работы: '),
        chip('Договор.Дата приёма', 'дата'),
        t('. Срок договора: '),
        chip('Договор.Срок'),
        t('.'),
      ]),
      numbered([
        t('Должностной оклад: '),
        chip('Договор.Оклад', 'число'),
        t(' ('),
        chip('Договор.Оклад', 'прописью'),
        t(') в месяц; ставка '),
        chip('Договор.Ставка'),
        t('. Режим работы: '),
        chip('Договор.График'),
        t('.'),
      ]),
      numbered([
        t('Испытательный срок: '),
        chip('Договор.Испытание до'),
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
    title: 'Приказ о приёме на работу',
    description:
      'Приказ по ст. 33 ТК РК. Подписывает руководитель ЭЦП, работник знакомится в системе; при применении заводится трудовая карточка.',
    docType: {
      name: 'Приказы о приёме',
      category: 'hr',
      numberFormat: 'ПР-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { name: 'Приказ о приёме', selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о приёме на работу'),
      docMeta(),
      p(
        [
          t('Принять '),
          chip('Сотрудник.ФИО'),
          t(' (ИИН '),
          chip('Сотрудник.ИИН'),
          t(') на должность '),
          chip('Договор.Должность'),
          t(' с '),
          chip('Действие.Дата вступления', 'дата'),
          t(' с должностным окладом '),
          chip('Договор.Оклад', 'число'),
          t(' тенге ('),
          chip('Договор.Оклад', 'прописью'),
          t(').'),
        ],
        'justify',
      ),
      p([t('Основание: трудовой договор № '), chip('Договор.Номер'), t(' от '), chip('Договор.Дата договора', 'дата'), t('.')]),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'transfer_order',
    version: 1,
    title: 'Приказ о переводе',
    description:
      'Перевод на другую должность/в другой филиал (ст. 38 ТК РК). При применении обновляется трудовая карточка; система предложит синхронизировать фактическое назначение.',
    docType: {
      name: 'Приказы о переводе',
      category: 'hr',
      numberFormat: 'ПР-П-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { name: 'Приказ о переводе', selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о переводе'),
      docMeta(),
      p(
        [
          t('Перевести '),
          chip('Сотрудник.ФИО'),
          t(' с должности '),
          chip('Договор.Должность'),
          t(' на должность '),
          chip('Действие.Новая должность'),
          t(' ('),
          chip('Действие.Новый филиал'),
          t(') с '),
          chip('Действие.Дата вступления', 'дата'),
          t('.'),
        ],
        'justify',
      ),
      p([t('Оклад с даты перевода: '), chip('Действие.Оклад', 'число'), t(' тенге ('), chip('Действие.Оклад', 'прописью'), t(').')]),
      p([]),
      sig('Директор', 'director', true),
      sig('С приказом ознакомлен(а): Работник', 'subject'),
    ]),
    route: { employerSign: true, subjectAck: true, register: true, file: true, hrApply: true },
  },
  {
    key: 'salary_order',
    version: 1,
    title: 'Приказ об изменении оклада',
    description:
      'Изменение оплаты труда — изменение условий трудового договора: не забудьте письменное уведомление за 15 календарных дней (ст. 46 п. 2 ТК РК), если изменение не по соглашению сторон.',
    docType: {
      name: 'Приказы об изменении оплаты',
      category: 'hr',
      numberFormat: 'ПР-ОТ-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { name: 'Приказ об изменении оклада', selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ об изменении должностного оклада'),
      docMeta(),
      p(
        [
          t('Установить '),
          chip('Сотрудник.ФИО'),
          t(' ('),
          chip('Договор.Должность'),
          t(') с '),
          chip('Действие.Дата вступления', 'дата'),
          t(' должностной оклад '),
          chip('Действие.Оклад', 'число'),
          t(' тенге ('),
          chip('Действие.Оклад', 'прописью'),
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
    title: 'Приказ о предоставлении отпуска',
    description:
      'Оплачиваемый ежегодный отпуск (ст. 88–92 ТК РК). Счётчик напомнит об оплате за 3 рабочих дня до начала (ст. 92 п. 4).',
    docType: {
      name: 'Приказы об отпусках',
      category: 'hr',
      numberFormat: 'ПР-О-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 5,
    },
    template: { name: 'Приказ об отпуске', selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о предоставлении отпуска'),
      docMeta(),
      p(
        [
          t('Предоставить '),
          chip('Сотрудник.ФИО'),
          t(' ('),
          chip('Договор.Должность'),
          t(') оплачиваемый ежегодный трудовой отпуск с '),
          chip('Действие.Дата вступления', 'дата'),
          t(' по '),
          chip('Действие.Дата окончания', 'дата'),
          t(' продолжительностью '),
          chip('Действие.Дней'),
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
    title: 'Приказ о прекращении трудового договора',
    description:
      'Акт о прекращении (ст. 61 ТК РК): вручается в течение 3 рабочих дней лично либо заказным письмом — вид включает режим обязательного вручения. Расчёт — 3 рабочих дня (ст. 113 п. 4).',
    docType: {
      name: 'Приказы об увольнении',
      category: 'hr',
      numberFormat: 'ПР-У-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      specialDelivery: true,
      retentionYears: 75,
    },
    template: { name: 'Приказ об увольнении', selfService: false, fields: [] },
    builderDoc: doc([
      requisites(),
      h('ПРИКАЗ о прекращении трудового договора'),
      docMeta(),
      p(
        [
          t('Прекратить действие трудового договора № '),
          chip('Договор.Номер'),
          t(' от '),
          chip('Договор.Дата договора', 'дата'),
          t(': уволить '),
          chip('Сотрудник.ФИО'),
          t(' ('),
          chip('Договор.Должность'),
          t(') '),
          chip('Действие.Дата вступления', 'дата'),
          t('. Основание: '),
          chip('Действие.Основание'),
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
    title: 'Заявление на отпуск',
    description:
      'Сотрудник подаёт сам («Подать заявление»); руководитель согласует, приказ создаётся кадровым действием «Отпуск».',
    docType: {
      name: 'Заявления',
      category: 'hr',
      numberFormat: 'ЗАЯВ-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'pep',
      toPersonalFile: false,
      retentionYears: 5,
    },
    template: {
      name: 'Заявление на отпуск',
      selfService: true,
      fields: [{ key: 'Период отпуска', label: 'Период отпуска', kind: 'daterange', required: true }],
    },
    builderDoc: doc([
      p([t('Директору '), chip('Организация.Юрнаименование')], 'right'),
      p([t('от '), chip('Сотрудник.ФИО'), t(' ('), chip('Договор.Должность'), t(')')], 'right'),
      h('ЗАЯВЛЕНИЕ'),
      p(
        [
          t('Прошу предоставить мне оплачиваемый ежегодный трудовой отпуск '),
          chip('Форма.Период отпуска'),
          t(' ('),
          chip('Форма.Период отпуска Дней'),
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
    title: 'Заявление об увольнении',
    description:
      'По собственному желанию (ст. 56 ТК РК): уведомление минимум за 1 месяц; отзыв заявления безусловен весь срок уведомления (ст. 56 п. 4).',
    docType: {
      name: 'Заявления об увольнении',
      category: 'hr',
      numberFormat: 'ЗАЯВ-У-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'pep',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: {
      name: 'Заявление об увольнении',
      selfService: true,
      fields: [{ key: 'Дата увольнения', label: 'Желаемая дата увольнения', kind: 'date', required: true }],
    },
    builderDoc: doc([
      p([t('Директору '), chip('Организация.Юрнаименование')], 'right'),
      p([t('от '), chip('Сотрудник.ФИО'), t(' ('), chip('Договор.Должность'), t(')')], 'right'),
      h('ЗАЯВЛЕНИЕ'),
      p(
        [
          t('Прошу расторгнуть трудовой договор по моей инициативе (ст. 56 Трудового кодекса РК) '),
          chip('Форма.Дата увольнения', 'дата'),
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
    title: 'Согласие на обработку персональных данных',
    description:
      'Ст. 8 Закона РК «О персональных данных». Копии удостоверения личности НЕ прикладываются (запрет ПД-правил с 12.07.2026 — реквизитных полей достаточно).',
    docType: {
      name: 'Согласия на обработку ПД',
      category: 'hr',
      numberFormat: 'ПД-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'pep',
      toPersonalFile: true,
      retentionYears: 75,
    },
    template: { name: 'Согласие на обработку ПД', selfService: false, fields: [] },
    builderDoc: doc([
      h('СОГЛАСИЕ на сбор и обработку персональных данных'),
      docMeta(),
      p(
        [
          t('Я, '),
          chip('Сотрудник.ФИО'),
          t(' (ИИН '),
          chip('Сотрудник.ИИН'),
          t('), в соответствии с Законом РК «О персональных данных и их защите» даю согласие '),
          chip('Организация.Юрнаименование'),
          t(' (БИН '),
          chip('Организация.БИН'),
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
    title: 'Уведомление об изменении условий труда',
    description:
      'Ст. 46 п. 2 ТК РК: за 15 календарных дней, с 08.06.2026 — только письменно (бумага или электронный документ с ЭЦП). Подписывает работодатель ЭЦП, работник знакомится.',
    docType: {
      name: 'Уведомления',
      category: 'hr',
      numberFormat: 'УВ-{ГГГГ}-{NNN}',
      visibility: 'managers',
      signatureLevel: 'ecp',
      toPersonalFile: true,
      retentionYears: 5,
    },
    template: {
      name: 'Уведомление об изменении условий труда',
      selfService: false,
      fields: [
        { key: 'Что меняется', label: 'Что меняется', kind: 'textarea', required: true },
        { key: 'Дата изменения', label: 'Дата изменения условий', kind: 'date', required: true },
      ],
    },
    builderDoc: doc([
      requisites(),
      h('УВЕДОМЛЕНИЕ об изменении условий труда'),
      docMeta(),
      p([chip('Сотрудник.ФИО'), t(' ('), chip('Договор.Должность'), t(')')]),
      p(
        [
          t('В соответствии со ст. 46 Трудового кодекса РК уведомляем об изменении условий труда с '),
          chip('Форма.Дата изменения', 'дата'),
          t(': '),
          chip('Форма.Что меняется'),
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
    title: 'Ознакомление с требованиями кибербезопасности',
    description:
      'С 25.08.2026 работодатель обязан ознакомить работников с требованиями кибербезопасности. Готовый ЛНА: установите и запустите кампанию ознакомления на всю организацию.',
    docType: {
      name: 'Локальные акты',
      category: 'hr',
      numberFormat: 'ЛНА-{ГГГГ}-{NNN}',
      visibility: 'team',
      signatureLevel: 'none',
      toPersonalFile: false,
      retentionYears: 5,
    },
    template: { name: 'Требования кибербезопасности', selfService: false, fields: [] },
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
