import { defineVisibilityTypes } from './types';

// ============================================================
// Трудовая карточка (КЭДО): как человек оформлен в организации.
// ============================================================
// Право на ЗАПИСЬ — гейт сервиса (сам и Менеджер+), поля — этот тип. Умолчания —
// решение грилла №12: оклад — владелец/админ + руководитель своих подчинённых +
// руководитель своего объекта + сам (ТК ст. 113: оклад от работника скрыть нельзя —
// `mandatoryVisible: self`); прочие условия договора — как было (управляющим).
// Основание увольнения — конфиденциально (ст. 52 ТК: причина — сведения о человеке).
// Реквизиты договора, которые печатаются в документах, — пол: их видит каждый, у кого
// есть карточка (печать — системный путь шаблонов, право решает документ).

const MANAGERS_FULL = { owner: 'full', admin: 'full', manager: 'full', staff: 'hidden', trainee: 'hidden', contractor: 'hidden' } as const;

export const HR_VISIBILITY = defineVisibilityTypes({
  'hr.employment': {
    service: 'hr',
    owner: 'workspace',
    subject: 'user',
    stages: ['draft', 'active', 'terminated'],
    floor: ['status', 'legalPositionName', 'legalBranchName', 'legalEntityName'],
    defaults: { roles: MANAGERS_FULL },
    sections: {
      contract: {
        fields: {
          hiredAt: { kind: 'date', class: 'internal', control: 'controller', group: 'employment', configurable: false },
          firedAt: { kind: 'date', class: 'internal', control: 'controller', group: 'employment', configurable: false },
          contractNumber: { kind: 'text', class: 'internal', control: 'controller', group: 'employment', configurable: false, caps: ['filter', 'sort', 'search'] },
          contractDate: { kind: 'date', class: 'internal', control: 'controller', group: 'employment', configurable: false },
          contractType: { kind: 'enum', class: 'internal', control: 'controller', group: 'employment', configurable: false, caps: ['filter', 'group'] },
          contractEndAt: { kind: 'date', class: 'internal', control: 'controller', group: 'employment', configurable: false, caps: ['filter', 'sort'] },
          probationUntil: { kind: 'date', class: 'internal', control: 'controller', group: 'employment', configurable: false },
          workRate: { kind: 'number', class: 'internal', control: 'controller', group: 'employment', configurable: false },
          workSchedule: { kind: 'text', class: 'internal', control: 'controller', group: 'employment', configurable: false },
          personnelNumber: { kind: 'text', class: 'internal', control: 'controller', group: 'employment', configurable: false, caps: ['search'] },
          dismissalGround: { kind: 'text', class: 'confidential', control: 'controller', group: 'employment', masks: ['text_hidden'] },
        },
      },
      pay: {
        fields: {
          salaryAmount: {
            kind: 'money',
            class: 'confidential',
            control: 'controller',
            group: 'finance',
            masks: ['money_bucket'],
            caps: ['export'],
            mandatoryVisible: ['self'],
            moneyBuckets: [10_000_000, 25_000_000, 50_000_000, 100_000_000, 200_000_000, 500_000_000],
            defaults: {
              roles: { owner: 'full', admin: 'full', manager: 'hidden', staff: 'hidden', trainee: 'hidden', contractor: 'hidden' },
              relative: { manager_of: 'full', branch_head_of: 'full' },
            },
          },
        },
      },
    },
  },
});
