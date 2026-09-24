import { defineVisibilityTypes } from './types';

// ============================================================
// Сотрудник организации глазами коллег и работодателя: реквизитный блок карточки
// («Для договоров и трудоустройства») и карта выплат.
// ============================================================
// СЛУЖЕБНЫЕ поля (`control: controller`, решение грилла №1): решает только организация;
// сам человек своё видит всегда (ЗоПД ст. 24). Умолчания — решение грилла №12: ИИН,
// удостоверение, адрес, карта — владелец и админ видят МАСКУ и раскрывают по одной записи
// (решение №3: первый раз за 15 минут — SMS), остальным скрыто.
//
// Номер карты — `secret` (R11): полного PAN в продукте не видит НИКТО, включая владельца и
// самого человека (PCI DSS 3.4.1); полный номер знает только путь выплат кошелька.
// Имя, роль и должности — пол записи: их видит каждый, кому открыт ростер. Фото — личное поле
// человека (`user.card.avatar`): ростер берёт его из карточки, а не из пола этого типа.

const RESTRICTED_DEFAULTS = {
  roles: { owner: 'masked', admin: 'masked', manager: 'hidden', staff: 'hidden', trainee: 'hidden', contractor: 'hidden' },
  reveal: ['owner', 'admin'],
} as const;

export const STAFF_VISIBILITY = defineVisibilityTypes({
  'staff.member': {
    service: 'staff',
    owner: 'workspace',
    subject: 'user',
    floor: ['userName', 'avatar', 'role', 'assignments', 'joinedAt'],
    defaults: RESTRICTED_DEFAULTS,
    sections: {
      requisites: {
        fields: {
          iin: {
            kind: 'id_number',
            class: 'restricted',
            control: 'controller',
            group: 'requisites',
            masks: ['id_last4'],
            mandatoryVisible: ['self'],
            pii: { model: 'User', field: 'iin' },
          },
          residentialAddress: {
            kind: 'address',
            class: 'restricted',
            control: 'controller',
            group: 'address',
            masks: ['address_city', 'text_hidden'],
            mandatoryVisible: ['self'],
            pii: { model: 'User', field: 'residentialAddress' },
          },
          idDocNumber: {
            kind: 'id_number',
            class: 'restricted',
            control: 'controller',
            group: 'requisites',
            masks: ['id_last4'],
            mandatoryVisible: ['self'],
            pii: { model: 'User', field: 'idDocNumber' },
          },
          idDocIssuedBy: {
            kind: 'text',
            class: 'restricted',
            control: 'controller',
            group: 'requisites',
            masks: ['text_hidden'],
            mandatoryVisible: ['self'],
            pii: { model: 'User', field: 'idDocIssuedBy' },
          },
          idDocIssuedAt: { kind: 'date', class: 'restricted', control: 'controller', group: 'requisites', masks: ['date_year'], mandatoryVisible: ['self'] },
        },
      },
      payment: {
        fields: {
          /** Полный номер карты не видит никто (секрет); маска — последние четыре */
          paymentCardPan: { kind: 'card', class: 'secret', control: 'controller', group: 'finance', masks: ['card_last4'], self: 'policy', defaults: { roles: RESTRICTED_DEFAULTS.roles, reveal: [] } },
          paymentCardIban: { kind: 'account', class: 'restricted', control: 'controller', group: 'finance', masks: ['id_last4'], mandatoryVisible: ['self'] },
          paymentCardHolder: { kind: 'name', class: 'confidential', control: 'controller', group: 'finance', masks: ['name_initials'] },
          paymentCardExpiry: { kind: 'date', class: 'confidential', control: 'controller', group: 'finance', masks: ['date_year'] },
        },
      },
    },
  },
});
