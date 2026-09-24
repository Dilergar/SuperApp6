import { defineVisibilityTypes } from './types';

// ============================================================
// Анкета организации: профиль, контакты, реквизиты (R10 ревю плана — бывший самодельный
// слой `Workspace.cardVisibility` + «владелец/админ видят всё» в `serializeWorkspace`).
// ============================================================
// Запись — сама организация (субъекта-человека нет). Умолчания повторяют прежнюю
// «Анкету компании»: профиль и реквизиты — команде, телефон и число сотрудников —
// только владельцу и админу. IBAN — `restricted`: владелец и админ видят маску и
// раскрывают по одной записи (ИП = ПДн предпринимателя); печать счёта — системный путь
// шаблонов, его маска не касается.

const TEAM_FULL = { owner: 'full', admin: 'full', manager: 'full', staff: 'full', trainee: 'full', contractor: 'hidden' } as const;
const ADMINS_FULL = { owner: 'full', admin: 'full', manager: 'hidden', staff: 'hidden', trainee: 'hidden', contractor: 'hidden' } as const;

export const WORKSPACE_CARD_VISIBILITY = defineVisibilityTypes({
  'workspace.card': {
    service: 'workspaces',
    owner: 'workspace',
    subject: 'none',
    floor: ['name', 'logo'],
    defaults: { roles: TEAM_FULL },
    sections: {
      profile: {
        fields: {
          description: { kind: 'text', class: 'public', control: 'controller', group: 'business' },
          industry: { kind: 'enum', class: 'public', control: 'controller', group: 'business' },
          city: { kind: 'text', class: 'public', control: 'controller', group: 'business' },
          website: { kind: 'url', class: 'public', control: 'controller', group: 'business' },
          membersCount: { kind: 'number', class: 'internal', control: 'controller', group: 'business', defaults: { roles: ADMINS_FULL } },
        },
      },
      contacts: {
        fields: {
          contactEmail: { kind: 'email', class: 'contact', control: 'controller', group: 'contacts', masks: ['email_partial'] },
          contactPhone: { kind: 'phone', class: 'contact', control: 'controller', group: 'contacts', masks: ['phone_partial'], defaults: { roles: ADMINS_FULL } },
        },
      },
      requisites: {
        fields: {
          /** Блок реквизитов целиком (юрформа, БИН, юрадрес, НДС, директор, банк) — печатается на каждом счёте */
          requisites: { kind: 'text', class: 'internal', control: 'controller', group: 'requisites' },
          iban: {
            kind: 'account',
            class: 'restricted',
            control: 'controller',
            group: 'requisites',
            masks: ['id_last4'],
            defaults: { roles: { owner: 'masked', admin: 'masked', manager: 'masked', staff: 'masked', trainee: 'masked', contractor: 'hidden' }, reveal: ['owner', 'admin'] },
            pii: { model: 'WorkspaceBankAccount', field: 'iban' },
          },
        },
      },
    },
  },
});
