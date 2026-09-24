import { defineVisibilityTypes } from './types';

// ============================================================
// Контрагент (+ контактные лица, банковские счета): внешняя сторона организации.
// ============================================================
// Право на запись — гейт ролью (команда, Подрядчик изолирован). Умолчания — решение
// грилла №12: контакты контрагента — стажёру и сотруднику МАСКОЙ, менеджеру и выше —
// полностью. Реквизиты для договора (юрнаименование, БИН, адреса, НДС, руководитель) —
// пол записи: без них не собрать ни одного документа, в матрице они приглушены.

const CONTACT_DEFAULTS = {
  roles: { owner: 'full', admin: 'full', manager: 'full', staff: 'masked', trainee: 'masked', contractor: 'hidden' },
} as const;

export const COUNTERPARTIES_VISIBILITY = defineVisibilityTypes({
  counterparty: {
    service: 'counterparties',
    owner: 'workspace',
    subject: 'none',
    floor: ['name', 'kind', 'legalName', 'bin', 'orgForm', 'legalAddress', 'actualAddress', 'kbe', 'taxRegime', 'vat', 'directorName', 'signBasis', 'comment'],
    defaults: CONTACT_DEFAULTS,
    sections: {
      contacts: {
        fields: {
          phone: { kind: 'phone', class: 'contact', control: 'controller', group: 'contacts', masks: ['phone_partial'], caps: ['search'], pii: { model: 'Counterparty', field: 'phone' } },
          email: { kind: 'email', class: 'contact', control: 'controller', group: 'contacts', masks: ['email_partial'], pii: { model: 'Counterparty', field: 'email' } },
          contactPhone: { kind: 'phone', class: 'contact', control: 'controller', group: 'contacts', masks: ['phone_partial'], pii: { model: 'CounterpartyContact', field: 'phone' } },
          contactEmail: { kind: 'email', class: 'contact', control: 'controller', group: 'contacts', masks: ['email_partial'], pii: { model: 'CounterpartyContact', field: 'email' } },
        },
      },
      bank: {
        fields: {
          iban: { kind: 'account', class: 'confidential', control: 'controller', group: 'finance', masks: ['id_last4'], pii: { model: 'CounterpartyBankAccount', field: 'iban' } },
        },
      },
    },
  },
});
