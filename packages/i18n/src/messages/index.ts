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
import m_en_tasks from './en/tasks.json';
import m_en_calendar from './en/calendar.json';
import m_en_circles from './en/circles.json';
import m_en_drive from './en/drive.json';
import m_en_notes from './en/notes.json';
import m_en_finance from './en/finance.json';
import m_en_wallet from './en/wallet.json';
import m_en_dashboard from './en/dashboard.json';
import m_en_workspaces from './en/workspaces.json';
import m_en_office from './en/office.json';
import m_en_calls from './en/calls.json';
import m_en_share from './en/share.json';
import m_en_approvals from './en/approvals.json';
import m_en_shop from './en/shop.json';
import m_en_objects from './en/objects.json';
import m_en_staff from './en/staff.json';
import m_en_counterparties from './en/counterparties.json';
import m_en_documents from './en/documents.json';
import m_en_sign from './en/sign.json';
import m_en_docs from './en/docs.json';
import m_en_processes from './en/processes.json';
import m_en_hr from './en/hr.json';
import m_en_recorder from './en/recorder.json';
import m_en_entitlements from './en/entitlements.json';
import m_en_platform from './en/platform.json';
import m_en_analytics from './en/analytics.json';
import m_en_templates from './en/templates.json';
import m_en_keys from './en/keys.json';
import m_en_consents from './en/consents.json';
import m_en_audit from './en/audit.json';
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
import m_kk_tasks from './kk/tasks.json';
import m_kk_calendar from './kk/calendar.json';
import m_kk_circles from './kk/circles.json';
import m_kk_drive from './kk/drive.json';
import m_kk_notes from './kk/notes.json';
import m_kk_finance from './kk/finance.json';
import m_kk_wallet from './kk/wallet.json';
import m_kk_dashboard from './kk/dashboard.json';
import m_kk_workspaces from './kk/workspaces.json';
import m_kk_office from './kk/office.json';
import m_kk_calls from './kk/calls.json';
import m_kk_share from './kk/share.json';
import m_kk_approvals from './kk/approvals.json';
import m_kk_shop from './kk/shop.json';
import m_kk_objects from './kk/objects.json';
import m_kk_staff from './kk/staff.json';
import m_kk_counterparties from './kk/counterparties.json';
import m_kk_documents from './kk/documents.json';
import m_kk_sign from './kk/sign.json';
import m_kk_docs from './kk/docs.json';
import m_kk_processes from './kk/processes.json';
import m_kk_hr from './kk/hr.json';
import m_kk_recorder from './kk/recorder.json';
import m_kk_entitlements from './kk/entitlements.json';
import m_kk_platform from './kk/platform.json';
import m_kk_analytics from './kk/analytics.json';
import m_kk_templates from './kk/templates.json';
import m_kk_keys from './kk/keys.json';
import m_kk_consents from './kk/consents.json';
import m_kk_audit from './kk/audit.json';
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
import m_ru_tasks from './ru/tasks.json';
import m_ru_calendar from './ru/calendar.json';
import m_ru_circles from './ru/circles.json';
import m_ru_drive from './ru/drive.json';
import m_ru_notes from './ru/notes.json';
import m_ru_finance from './ru/finance.json';
import m_ru_wallet from './ru/wallet.json';
import m_ru_dashboard from './ru/dashboard.json';
import m_ru_workspaces from './ru/workspaces.json';
import m_ru_office from './ru/office.json';
import m_ru_calls from './ru/calls.json';
import m_ru_share from './ru/share.json';
import m_ru_approvals from './ru/approvals.json';
import m_ru_shop from './ru/shop.json';
import m_ru_objects from './ru/objects.json';
import m_ru_staff from './ru/staff.json';
import m_ru_counterparties from './ru/counterparties.json';
import m_ru_documents from './ru/documents.json';
import m_ru_sign from './ru/sign.json';
import m_ru_docs from './ru/docs.json';
import m_ru_processes from './ru/processes.json';
import m_ru_hr from './ru/hr.json';
import m_ru_recorder from './ru/recorder.json';
import m_ru_entitlements from './ru/entitlements.json';
import m_ru_platform from './ru/platform.json';
import m_ru_analytics from './ru/analytics.json';
import m_ru_templates from './ru/templates.json';
import m_ru_keys from './ru/keys.json';
import m_ru_consents from './ru/consents.json';
import m_ru_audit from './ru/audit.json';

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
    "tasks": m_en_tasks,
    "calendar": m_en_calendar,
    "circles": m_en_circles,
    "drive": m_en_drive,
    "notes": m_en_notes,
    "finance": m_en_finance,
    "wallet": m_en_wallet,
    "dashboard": m_en_dashboard,
    "workspaces": m_en_workspaces,
    "office": m_en_office,
    "calls": m_en_calls,
    "share": m_en_share,
    "approvals": m_en_approvals,
    "shop": m_en_shop,
    "objects": m_en_objects,
    "staff": m_en_staff,
    "counterparties": m_en_counterparties,
    "documents": m_en_documents,
    "sign": m_en_sign,
    "docs": m_en_docs,
    "processes": m_en_processes,
    "hr": m_en_hr,
    "recorder": m_en_recorder,
    "entitlements": m_en_entitlements,
    "platform": m_en_platform,
    "analytics": m_en_analytics,
    "templates": m_en_templates,
    "keys": m_en_keys,
    "consents": m_en_consents,
    "audit": m_en_audit,
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
    "tasks": m_kk_tasks,
    "calendar": m_kk_calendar,
    "circles": m_kk_circles,
    "drive": m_kk_drive,
    "notes": m_kk_notes,
    "finance": m_kk_finance,
    "wallet": m_kk_wallet,
    "dashboard": m_kk_dashboard,
    "workspaces": m_kk_workspaces,
    "office": m_kk_office,
    "calls": m_kk_calls,
    "share": m_kk_share,
    "approvals": m_kk_approvals,
    "shop": m_kk_shop,
    "objects": m_kk_objects,
    "staff": m_kk_staff,
    "counterparties": m_kk_counterparties,
    "documents": m_kk_documents,
    "sign": m_kk_sign,
    "docs": m_kk_docs,
    "processes": m_kk_processes,
    "hr": m_kk_hr,
    "recorder": m_kk_recorder,
    "entitlements": m_kk_entitlements,
    "platform": m_kk_platform,
    "analytics": m_kk_analytics,
    "templates": m_kk_templates,
    "keys": m_kk_keys,
    "consents": m_kk_consents,
    "audit": m_kk_audit,
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
    "tasks": m_ru_tasks,
    "calendar": m_ru_calendar,
    "circles": m_ru_circles,
    "drive": m_ru_drive,
    "notes": m_ru_notes,
    "finance": m_ru_finance,
    "wallet": m_ru_wallet,
    "dashboard": m_ru_dashboard,
    "workspaces": m_ru_workspaces,
    "office": m_ru_office,
    "calls": m_ru_calls,
    "share": m_ru_share,
    "approvals": m_ru_approvals,
    "shop": m_ru_shop,
    "objects": m_ru_objects,
    "staff": m_ru_staff,
    "counterparties": m_ru_counterparties,
    "documents": m_ru_documents,
    "sign": m_ru_sign,
    "docs": m_ru_docs,
    "processes": m_ru_processes,
    "hr": m_ru_hr,
    "recorder": m_ru_recorder,
    "entitlements": m_ru_entitlements,
    "platform": m_ru_platform,
    "analytics": m_ru_analytics,
    "templates": m_ru_templates,
    "keys": m_ru_keys,
    "consents": m_ru_consents,
    "audit": m_ru_audit,
  },
};
