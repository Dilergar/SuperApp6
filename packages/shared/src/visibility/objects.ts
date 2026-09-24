import { defineVisibilityTypes } from './types';

// ============================================================
// Объекты: штатное расписание и деньги объекта; график смен и факт выходов.
// ============================================================
// Право на запись — объект (`caps.view`); поля — эти типы. Умолчания — решение грилла №12:
// деньги штатки — владелец/админ + руководитель объекта + держатель пообъектного гранта
// «видит деньги» + руководитель своих подчинённых + сам (своя ставка). Смены: план — всем,
// кто видит объект; факт, опоздания и заметки — планировщикам (руководитель объекта) и
// самому. Фильтр «рядовой видит только СВОИ строки табеля» — record-level, он остаётся в
// `AttendanceService` (R13): движок отвечает за поля видимых строк.

const PAYROLL_DEFAULTS = {
  roles: { owner: 'full', admin: 'full', manager: 'hidden', staff: 'hidden', trainee: 'hidden', contractor: 'hidden' },
  relative: { branch_head_of: 'full', branch_payroll: 'full', manager_of: 'full' },
} as const;

const FACT_DEFAULTS = {
  roles: { owner: 'full', admin: 'full', manager: 'hidden', staff: 'hidden', trainee: 'hidden', contractor: 'hidden' },
  // Ведущий график (в т.ч. делегат) отмечает факт — и видит его; деньги ему не открываются
  relative: { branch_head_of: 'full', branch_scheduler: 'full', manager_of: 'full' },
} as const;

export const OBJECTS_VISIBILITY = defineVisibilityTypes({
  'objects.staffing': {
    service: 'objects',
    owner: 'workspace',
    subject: 'user',
    floor: ['positionName', 'headcount', 'filled', 'assignment', 'schedule', 'shifts', 'vacantSince'],
    defaults: PAYROLL_DEFAULTS,
    sections: {
      money: {
        fields: {
          /** Оклад по договору КЭДО — тот же факт, что `hr.employment.salaryAmount` */
          officialSalary: { kind: 'money', class: 'confidential', control: 'controller', group: 'finance', derivedFrom: ['hr.employment.salaryAmount'], mandatoryVisible: ['self'] },
          actualRate: { kind: 'money', class: 'confidential', control: 'controller', group: 'finance', mandatoryVisible: ['self'] },
          /**
           * Плановая ставка штатной единицы — бюджет организации, а не «своё» человека: на строке
           * самого сотрудника она решается правилами (`self: 'policy'`), а не правом «сам видит своё»
           */
          plannedRate: { kind: 'money', class: 'confidential', control: 'controller', group: 'finance', self: 'policy' },
          plannedCost: { kind: 'money', class: 'confidential', control: 'controller', group: 'finance', derivedFrom: ['plannedRate'], caps: ['aggregate'], self: 'policy' },
          employment: { kind: 'text', class: 'confidential', control: 'controller', group: 'employment' },
        },
      },
    },
  },
  'objects.shift': {
    service: 'objects',
    owner: 'workspace',
    subject: 'user',
    floor: ['localDate', 'startsAt', 'endsAt', 'breakMin', 'templateName', 'positionName', 'userName', 'status'],
    defaults: FACT_DEFAULTS,
    sections: {
      plan: {
        fields: {
          /** Заметка к смене — часть ПЛАНА: видна всем, кто видит опубликованную смену */
          shiftNote: {
            kind: 'text',
            class: 'internal',
            control: 'controller',
            group: 'schedule',
            masks: ['text_hidden'],
            defaults: { roles: { owner: 'full', admin: 'full', manager: 'full', staff: 'full', trainee: 'full', contractor: 'hidden' } },
          },
        },
      },
      attendance: {
        fields: {
          outcome: { kind: 'enum', class: 'confidential', control: 'controller', group: 'schedule', caps: ['filter', 'group'] },
          lateMin: { kind: 'number', class: 'confidential', control: 'controller', group: 'schedule' },
          actualStartAt: { kind: 'date', class: 'confidential', control: 'controller', group: 'schedule' },
          actualEndAt: { kind: 'date', class: 'confidential', control: 'controller', group: 'schedule' },
          attendanceNote: { kind: 'text', class: 'confidential', control: 'controller', group: 'schedule', masks: ['text_hidden'] },
        },
      },
    },
  },
});
