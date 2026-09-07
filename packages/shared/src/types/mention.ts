import { MENTION_SOURCE_TYPES } from '../constants/mention';

export type MentionSourceType = (typeof MENTION_SOURCE_TYPES)[number];

/**
 * Кандидат @-пикера (участник текущего чата). Лента упоминаний как отдельная
 * модель ушла: упоминание = уведомление `mention.received` с `reason: 'mention'`
 * (`GET /notifications?mentions=1`).
 */
export interface MentionCandidate {
  userId: string;
  name: string;
  avatar: string | null;
}
