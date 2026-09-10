import {
  AUDIENCE_KINDS,
  audienceAnchorKey,
  audienceKindKey,
  isAudienceAnchor,
  type AudienceKind,
  type AudienceLabelSnapshot,
} from '@superapp/shared';
import type { Translator } from './translator';

// ============================================================
// Подпись АДРЕСАТА в вечной записи: снимок структуры → слово при чтении.
//
// Хроника и уведомление живут в БД годами, а «Отдел «Продажи»» — это два разных
// сорта текста в одной фразе: «Отдел» — СЛОВО ПРОДУКТА (у каждого читателя своё),
// «Продажи» — ДАННЫЕ (имя справочника на момент записи). Готовая фраза замораживает
// оба: записанная по-русски, она и через год покажется английскому читателю
// по-русски — ровно та болезнь, от которой лечит `<имя>Key` (docs/i18n.md,
// «Ключ вместо слова в payload»).
//
// Поэтому продюсер кладёт в payload СНИМОК под именем с суффиксом `Audience`:
//
//   payload: { principalLabelAudience: { kind: 'department', id: '…', key: 'common.audience.label.department', name: 'Продажи' } }
//   каталог: "{actorName} открыл(а) доступ к «{targetName}»: {principalLabel}"
//
// Рендер подставляет собранную подпись под именем БЕЗ суффикса — и в хронике
// (`renderChatter`), и в уведомлениях (`NotificationsRenderer`). Уже заданное имя
// (снимок старой записи, сделанной до этого правила) не перебивается: накопленные
// строки читаются как есть.
// ============================================================

const SUFFIX = 'Audience';

const KINDS: readonly string[] = AUDIENCE_KINDS;

/** Слово вместо пропавшего имени — общее с `renderChatter` (`{actorName}` без снимка) */
const SOMEONE_KEY = 'common.labels.someone';

/**
 * Похоже ли значение payload на снимок адресата. Проверка рантайм-строгая: payload
 * приходит из БД типом `unknown`, и чужой объект не должен превращаться в подпись.
 */
export function isAudienceLabelSnapshot(value: unknown): value is AudienceLabelSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !KINDS.includes(v.kind)) return false;
  if (typeof v.id !== 'string' || !v.id) return false;
  if (v.key != null && typeof v.key !== 'string') return false;
  if (v.name != null && typeof v.name !== 'string') return false;
  return true;
}

/**
 * Снимок адресата → подпись в языке ЗРИТЕЛЯ.
 *
 * Ступени: форма из каталога (`«Отдел «{name}»»`, `«Руководитель {who}»`) → имя
 * снимком → слово якоря → подпись вида → сам вид. Каждая следующая включается,
 * когда предыдущей нет: ключ мог уехать из каталога вместе с переименованием, а
 * запись обязана остаться читаемой.
 */
export function renderAudienceLabel(t: Translator, snap: AudienceLabelSnapshot): string {
  // `who` («инициатора», «Иван Петров») — второе слово относительной подписи. Якорь
  // хранится в записи как есть (`$initiator`), потому что человека за ним разворот
  // выбирает В МОМЕНТ ЧТЕНИЯ маршрута, а не в момент записи. Имени нет (аккаунт
  // удалён) — слово-заглушку даёт КАТАЛОГ здесь, а не снимок: в записи его нельзя
  // было бы перевести.
  const someone = () => (t.has(SOMEONE_KEY) ? t(SOMEONE_KEY) : '');
  const who = isAudienceAnchor(snap.id) ? t(audienceAnchorKey(snap.id)) : snap.name ?? someone();
  if (snap.key && t.has(snap.key)) return t(snap.key, { name: snap.name ?? '', who });
  if (snap.name) return snap.name;
  if (isAudienceAnchor(snap.id)) return who;
  // Человек без имени — «Кто-то», а не «Человек»: подпись ВИДА тут читалась бы как
  // название колонки, а не как участник.
  if (snap.kind === 'user') return someone();
  const kindKey = audienceKindKey(snap.kind as AudienceKind);
  return t.has(kindKey) ? t(kindKey) : snap.kind;
}

/**
 * Развернуть `<имя>Audience` в `<имя>` подписью в языке зрителя. Возвращает НОВЫЙ
 * объект; уже заданное `<имя>` (снимок старой записи) не перебивается.
 *
 * Работает по СЫРОМУ payload — до того, как рендер выбросит объекты: снимок и есть
 * объект, и выброси его раньше, подпись собирать было бы не из чего.
 */
export function resolveAudienceLabels(
  t: Translator,
  values: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(values)) {
    if (!name.endsWith(SUFFIX) || name.length === SUFFIX.length) continue;
    if (!isAudienceLabelSnapshot(value)) continue;
    const target = name.slice(0, -SUFFIX.length);
    if (values[target] !== undefined) continue;
    out ??= { ...values };
    out[target] = renderAudienceLabel(t, value);
  }
  return out ?? values;
}
