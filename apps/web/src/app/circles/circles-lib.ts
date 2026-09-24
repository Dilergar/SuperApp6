// ============================================================
// «Моё окружение» — чистые помощники страницы (без JSX).
//
// Сюда вынесено всё, что раньше жило копипастой прямо в page.tsx: разбор
// ошибок API, склонения, фильтр/сортировка списка людей, пороги и палитры.
// ============================================================

import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import type { Circle, Contact } from '@superapp/shared';
import { guardedDisplay, visibleOr } from '@superapp/shared';

/**
 * Палитра цвета Группы. Это ДАННЫЕ (цвет выбирает человек), а не цвет системы,
 * поэтому живёт рядом со своей формой, а не в токенах (DESIGN.md §1).
 *
 * Показываются ВСЕ восемь: раньше список резался `.slice(0, 6)` на месте, и два
 * последних цвета существовали только в коде — выбрать их было нельзя.
 * У каждого образца есть ИМЯ: пять безымянных квадратиков подряд — это пять
 * кнопок без названия, и выбрать цвет с клавиатуры было невозможно.
 */
export const GROUP_COLORS: { value: string; key: string }[] = [
  { value: '#f0c4c2', key: 'pink' },
  { value: '#c3d8f0', key: 'sky' },
  { value: '#eed6ae', key: 'sand' },
  { value: '#c6ddc7', key: 'green' },
  { value: '#e1bee7', key: 'lilac' },
  { value: '#ffccbc', key: 'peach' },
  { value: '#b2dfdb', key: 'teal' },
  { value: '#f0f4c3', key: 'lime' },
];

/**
 * Минимальная длина номера, при которой имеет смысл искать человека:
 * «+7» + 10 цифр = 12 символов. Порог был захардкожен в двух местах (запуск
 * поиска и блокировка кнопки «Отправить»), и они могли разъехаться.
 */
export const PHONE_LOOKUP_MIN_LENGTH = 12;

/** Через сколько дней до конца TTL приглашение считается «горящим». */
export const INVITATION_EXPIRY_WARN_DAYS = 3;

export type VisField =
  | 'city' | 'bio' | 'dateOfBirth' | 'age'
  | 'maritalStatus' | 'email' | 'socialLinks' | 'onlineStatus';

/** Порядок полей карточки; подпись — `circles.visField.<key>` в каталоге. */
export const VIS_FIELDS: readonly VisField[] = [
  'city',
  'bio',
  'dateOfBirth',
  'age',
  'maritalStatus',
  'email',
  'socialLinks',
  'onlineStatus',
];

export type ContactSort = 'recent' | 'name';

/**
 * Одна точка разбора ошибок страницы. Раньше блок
 * `catch (err: unknown) { const a = err as {...}; setError(...) }` был скопирован
 * одиннадцать раз, и каждая копия знала форму ответа API самостоятельно.
 * Возвращает true при успехе — вызывающий решает, закрывать ли форму.
 */
export async function runAction(action: () => Promise<void>, okMessage?: string): Promise<boolean> {
  try {
    await action();
    if (okMessage) toast(okMessage, 'success');
    return true;
  } catch (err) {
    toastApiError(err);
    return false;
  }
}

/** Сколько целых дней осталось до срока (отрицательное — срок прошёл). */
export function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

/** Только цифры — чтобы «+7 700 …» и «7700…» искались одинаково. */
function digits(s: string): string {
  return s.replace(/\D+/g, '');
}

/**
 * Один ли это номер. Сравниваем по цифрам: пользователь вводит номер как хочет,
 * а нормализацию делает сервер — посимвольное равенство здесь врало бы.
 */
export function samePhone(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  return da.length > 0 && da === db;
}

/**
 * Порядок Групп в фильтре: сначала `sortOrder`, при равенстве — по имени в
 * алфавите ЗРИТЕЛЯ (сравнение приходит параметром: чистая функция языка не знает).
 * Одна функция на чипы-фильтры и на перестановку в окне правки, иначе «Выше»
 * двигало бы группу относительно НЕ того списка, который человек видит.
 */
export function sortGroups(groups: Circle[], compare: (a: string, b: string) => number): Circle[] {
  return [...groups].sort((a, b) =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : compare(a.name, b.name),
  );
}

/**
 * Фильтр по имени/фамилии/роли/телефону. Работает по УЖЕ загруженным страницам —
 * серверного поиска по окружению нет, поэтому страница честно подсказывает,
 * что ниже могут быть ещё не загруженные люди.
 */
export function filterContacts(list: Contact[], query: string): Contact[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const qDigits = digits(q);
  return list.filter((c) => {
    const haystack = [
      c.them.firstName,
      c.them.lastName ?? '',
      c.myRole ?? '',
      c.theirRole ?? '',
    ].join(' ').toLowerCase();
    if (haystack.includes(q)) return true;
    // По номеру ищем только когда во вводе есть цифры: иначе пустая строка
    // цифр совпала бы с любым телефоном.
    return qDigits.length > 0 && digits(visibleOr(c.them.phone, '')).includes(qDigits);
  });
}

/**
 * Сортировка грида. `recent` — как отдаёт сервер (сначала недавно
 * подтверждённые), `name` — по имени и фамилии с русским сравнением.
 */
export function sortContacts(
  list: Contact[],
  sort: ContactSort,
  compare: (a: string, b: string) => number,
): Contact[] {
  if (sort === 'recent') {
    return [...list].sort(
      (a, b) => new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime(),
    );
  }
  // Сравнение имён — правилами ВЫБРАННОГО языка, а не языка браузера: в Казахстане
  // русская Windows у казахоязычного человека обычное дело, и `Intl.Collator(undefined)`
  // сортировал бы его окружение русским алфавитом вопреки его же выбору.
  return [...list].sort((a, b) => {
    const byFirst = compare(a.them.firstName, b.them.firstName);
    if (byFirst !== 0) return byFirst;
    return compare(guardedDisplay(a.them.lastName) ?? '', guardedDisplay(b.them.lastName) ?? '');
  });
}
