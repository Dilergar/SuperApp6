// СГЕНЕРИРОВАНО `pnpm --filter @superapp/i18n gen` — правки затрутся.
// Источник: src/messages/<locale>/<namespace>.json + src/namespaces.ts.
import type { Locale } from '@superapp/shared';
import type { Namespace } from '../namespaces';

import m_en_common from './en/common.json';
import m_en_shell from './en/shell.json';
import m_en_auth from './en/auth.json';
import m_en_landing from './en/landing.json';
import m_en_profile from './en/profile.json';
import m_en_errors from './en/errors.json';
import m_en_notifications from './en/notifications.json';
import m_en_chatter from './en/chatter.json';
import m_en_messenger from './en/messenger.json';
import m_en_richCards from './en/richCards.json';
import m_kk_common from './kk/common.json';
import m_kk_shell from './kk/shell.json';
import m_kk_auth from './kk/auth.json';
import m_kk_landing from './kk/landing.json';
import m_kk_profile from './kk/profile.json';
import m_kk_errors from './kk/errors.json';
import m_kk_notifications from './kk/notifications.json';
import m_kk_chatter from './kk/chatter.json';
import m_kk_messenger from './kk/messenger.json';
import m_kk_richCards from './kk/richCards.json';
import m_ru_common from './ru/common.json';
import m_ru_shell from './ru/shell.json';
import m_ru_auth from './ru/auth.json';
import m_ru_landing from './ru/landing.json';
import m_ru_profile from './ru/profile.json';
import m_ru_errors from './ru/errors.json';
import m_ru_notifications from './ru/notifications.json';
import m_ru_chatter from './ru/chatter.json';
import m_ru_messenger from './ru/messenger.json';
import m_ru_richCards from './ru/richCards.json';

/** Дерево сообщений одного неймспейса (значения — ICU-строки). */
export type MessageTree = { [key: string]: string | MessageTree };

export const MESSAGES: Record<Locale, Record<Namespace, MessageTree>> = {
  en: {
    "common": m_en_common,
    "shell": m_en_shell,
    "auth": m_en_auth,
    "landing": m_en_landing,
    "profile": m_en_profile,
    "errors": m_en_errors,
    "notifications": m_en_notifications,
    "chatter": m_en_chatter,
    "messenger": m_en_messenger,
    "richCards": m_en_richCards,
  },
  kk: {
    "common": m_kk_common,
    "shell": m_kk_shell,
    "auth": m_kk_auth,
    "landing": m_kk_landing,
    "profile": m_kk_profile,
    "errors": m_kk_errors,
    "notifications": m_kk_notifications,
    "chatter": m_kk_chatter,
    "messenger": m_kk_messenger,
    "richCards": m_kk_richCards,
  },
  ru: {
    "common": m_ru_common,
    "shell": m_ru_shell,
    "auth": m_ru_auth,
    "landing": m_ru_landing,
    "profile": m_ru_profile,
    "errors": m_ru_errors,
    "notifications": m_ru_notifications,
    "chatter": m_ru_chatter,
    "messenger": m_ru_messenger,
    "richCards": m_ru_richCards,
  },
};
