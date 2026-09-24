// Политики жизненного цикла Мессенджера (apps/api/src/modules/messenger). Решения грилла:
// личные сообщения — вечно, пока человек сам не удалит (+ таймер автоудаления на чат);
// чаты организации — политика владельца в коридоре [пол закона; потолок тарифа], умолчание
// «вечно»; след удалённого аккаунта в общих чатах остаётся, автор рисуется томбстоуном.
// Сообщения НЕ партиционируются: чтение «последние N в чате» идёт по `(chatId, seq)`.
import {
  CASCADE,
  CASCADE_FK,
  CONTRACT,
  FOREVER,
  HARD_DELETE,
  batched,
  byChat,
  deep,
  forDays,
  keep,
  notEnforced,
  pseudonymize,
  retainLegal,
  shallow,
  subject,
  tenantHook,
  withParent,
} from './helpers';
import type { LifecyclePolicyInput } from './types';

export const MESSENGER_LIFECYCLE = {
  Chat: {
    owner: 'messenger',
    version: 1,
    dataClass: 'user_content_shared',
    ownerKey: byChat('id'),
    subjects: [subject('createdById', 'author')],
    legalBasis: CONTRACT,
    retention: keep(),
    onSubjectErasure: pseudonymize('createdById'),
    // Чаты организации находятся по `workspaceId` (раньше — только через parentType задач и
    // комнат): хук стирает сообщения батчами по (chatId, seq), затем строки чатов
    onTenantPurge: tenantHook('messenger.workspace-chats'),
    edges: [
      deep('ChatMember', 'chatId'),
      deep('Message', 'chatId'),
      deep('ScheduledMessage', 'chatId'),
      { to: 'SearchDocument', kind: 'async_delete', via: 'chatId' },
      { to: 'CallSession', kind: 'async_delete', via: 'refId' },
    ],
    enforcement: notEnforced('a conversation lives while its members do; organisation chats go with the organisation'),
    holdAware: true,
    exportable: 'both',
  },
  ChatMember: {
    owner: 'messenger',
    version: 1,
    dataClass: 'user_content_shared',
    ownerKey: byChat('chatId'),
    subjects: [subject('userId', 'member')],
    legalBasis: CONTRACT,
    retention: withParent,
    onSubjectErasure: HARD_DELETE,
    onTenantPurge: CASCADE_FK,
    edges: [],
    enforcement: CASCADE,
    holdAware: true,
  },
  Message: {
    owner: 'messenger',
    version: 1,
    dataClass: 'user_content_shared',
    ownerKey: byChat('chatId'),
    subjects: [subject('authorId', 'author')],
    legalBasis: CONTRACT,
    // Личный чат — вечно + таймер человека (1/7/30 дней); чат организации — коридор [1 день; вечно]
    // по тарифу. Сокращённый срок действует НЕМЕДЛЕННО при чтении (seq ≥ пол чата), purge лишь
    // освобождает место.
    retention: {
      trigger: 'created',
      floorDays: 1,
      defaultDays: FOREVER,
      tenantConfigurable: true,
      userConfigurable: true,
      entitlementKey: 'lifecycle.retention.user_content_shared.ceilingDays',
    },
    // Текст в общих чатах остаётся у собеседников (права третьих лиц), автор рисуется
    // томбстоуном «Удалённый пользователь» по строке User; по желанию человека мастер удаления
    // стирает все его сообщения (tombstone: content = null, payload = null)
    onSubjectErasure: retainLegal('kz_civil_code_art41_4', FOREVER),
    onTenantPurge: CASCADE_FK,
    edges: [shallow('Message', 'replyToId'), { to: 'FileLink', kind: 'async_delete', via: 'refId' },
      // Проекция в поиске: стёртое по сроку сообщение не находится поиском
      { to: 'SearchDocument', kind: 'async_delete', via: 'sourceId' }],
    enforcement: batched('createdAt', undefined, 'messenger.retention'),
    holdAware: true,
    rootEntity: true,
    exportable: 'both',
  },
  ScheduledMessage: {
    owner: 'messenger',
    version: 1,
    dataClass: 'user_content_private',
    ownerKey: byChat('chatId'),
    subjects: [subject('authorId', 'author')],
    legalBasis: CONTRACT,
    retention: forDays(30, 'event:terminal'),
    onSubjectErasure: HARD_DELETE,
    onTenantPurge: CASCADE_FK,
    edges: [],
    enforcement: batched('updatedAt', { status: ['sent', 'cancelled', 'failed'] }),
    holdAware: true,
  },
} satisfies Record<string, LifecyclePolicyInput>;
