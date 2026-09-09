import type { Locale } from '@superapp/i18n';
import type { NumberWords } from './types';
import { wordsEn } from './en';
import { wordsKk } from './kk';
import { wordsRu } from './ru';

/**
 * Числительные по языку БЛАНКА. Языков ровно столько, сколько у платформы, —
 * иначе «прописью» молча печаталась бы чужими словами посреди документа.
 */
const BY_LOCALE: Record<Locale, NumberWords> = {
  en: wordsEn,
  kk: wordsKk,
  ru: wordsRu,
};

export function numberWordsFor(locale: Locale): NumberWords {
  return BY_LOCALE[locale] ?? wordsEn;
}

export type { NumberWords };
