import { defineVisibilityTypes } from './types';

// ============================================================
// Карточка человека (B2C + B2B): что о человеке видят Окружение, коллеги и посторонние.
// ============================================================
// ВСЕ поля — ЛИЧНЫЕ (`control: subject`, решение грилла №1): решает только сам человек,
// организация не может ни скрыть, ни раскрыть. Его настройки для Окружения и для коллег
// ОБЪЕДИНЯЮТСЯ (друг из Группы видит ДР и на работе). Умолчания — решение грилла №8:
// имя, фамилия, фото — Все; телефон, город, био, соцсети, ДР (день-месяц), «был в сети» —
// Окружение (и коллеги, как было в «Видимости в Компаниях»); год рождения, e-mail,
// семейное положение — Никто. Реквизиты (ИИН, адрес, удостоверение) сюда НЕ входят: это
// служебные поля организации (`staff.member`), в личном Окружении их нет вовсе.

export const USER_CARD_VISIBILITY = defineVisibilityTypes({
  'user.card': {
    service: 'profile',
    owner: 'user',
    subject: 'user',
    floor: ['firstName'],
    defaults: { audiences: ['everybody'] },
    sections: {
      identity: {
        fields: {
          /** Фамилия: связанным — полностью, посторонним — инициалом (пре-линк карточка, находимость) */
          lastName: {
            kind: 'name',
            class: 'public',
            control: 'subject',
            group: 'identity',
            masks: ['name_initials'],
            configurable: false,
            defaults: { audiences: ['circle_all', 'colleagues'] },
            fallback: { known: 'masked', stranger: 'masked' },
          },
          avatar: { kind: 'image', class: 'public', control: 'subject', group: 'identity', defaults: { audiences: ['everybody'] } },
          /** ДР без года (Graph API `MM/DD`) — настраивается отдельно от года */
          birthDayMonth: {
            kind: 'date',
            class: 'personal',
            control: 'subject',
            group: 'identity',
            masks: ['date_month_day'],
            defaults: { audiences: ['circle_all'] },
            pii: { model: 'User', field: 'dateOfBirth' },
          },
          /** Год рождения (и возраст — производное) */
          birthYear: {
            kind: 'date',
            class: 'personal',
            control: 'subject',
            group: 'identity',
            masks: ['date_year'],
            defaults: { audiences: [] },
            pii: { model: 'User', field: 'dateOfBirth' },
          },
          age: {
            kind: 'number',
            class: 'personal',
            control: 'subject',
            group: 'identity',
            configurable: false,
            derivedFrom: ['birthYear'],
            defaults: { audiences: [] },
          },
          maritalStatus: { kind: 'enum', class: 'personal', control: 'subject', group: 'identity', defaults: { audiences: [] } },
        },
      },
      contacts: {
        fields: {
          /**
           * Личный номер: «скрыт ≠ недостижим» — связанный человек видит маску, а Мессенджер и
           * звонки платформы работают; постороннему номер скрыт целиком.
           */
          phone: {
            kind: 'phone',
            class: 'contact',
            control: 'subject',
            group: 'contacts',
            masks: ['phone_partial'],
            defaults: { audiences: ['circle_all', 'colleagues'] },
            fallback: { known: 'masked', stranger: 'hidden' },
            pii: { model: 'User', field: 'phone' },
          },
          email: {
            kind: 'email',
            class: 'contact',
            control: 'subject',
            group: 'contacts',
            masks: ['email_partial'],
            defaults: { audiences: [] },
            pii: { model: 'User', field: 'email' },
          },
          socialLinks: { kind: 'url', class: 'personal', control: 'subject', group: 'contacts', defaults: { audiences: ['circle_all', 'colleagues'] } },
        },
      },
      profile: {
        fields: {
          city: { kind: 'text', class: 'personal', control: 'subject', group: 'address', defaults: { audiences: ['circle_all', 'colleagues'] } },
          bio: { kind: 'text', class: 'personal', control: 'subject', group: 'profile', defaults: { audiences: ['circle_all', 'colleagues'] } },
        },
      },
      presence: {
        fields: {
          /**
           * «Был в сети» — ОДНО поле на все сигналы присутствия (online, lastSeen, печатает,
           * прочитано): несколько сигналов порознь складываются обратно (Careless Whisper).
           * Взаимность: скрыл своё — видишь чужое только корзиной.
           */
          presence: {
            kind: 'presence',
            class: 'personal',
            control: 'subject',
            group: 'presence',
            masks: ['time_bucket'],
            reciprocal: true,
            defaults: { audiences: ['circle_all', 'colleagues'] },
            fallback: { known: 'masked', stranger: 'hidden' },
          },
        },
      },
    },
  },
});
