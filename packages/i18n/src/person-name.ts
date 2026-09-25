import { SUPPORTED_LOCALES, type Locale } from './config';
import { MESSAGES, type MessageTree } from './messages';

/**
 * Имя, которое нельзя взять живому человеку: метка томбстоуна стёртого на любом языке
 * платформы (без учёта регистра) — иначе он выдавал бы себя за стёртого, а зритель видел бы
 * его меткой на своём языке. Серверный модуль: читает каталоги всех языков.
 */
export function isReservedPersonName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLocaleLowerCase();
  return !!n && SUPPORTED_LOCALES.some((l: Locale) => deletedLabelOf(l).toLocaleLowerCase() === n);
}

function deletedLabelOf(locale: Locale): string {
  const common = MESSAGES[locale].common as MessageTree;
  const labels = common.labels as MessageTree;
  return String(labels.deletedUser ?? '');
}
