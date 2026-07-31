/**
 * Значок сущности в ТЕКСТЕ.
 *
 * Значок хранится одной строкой и может нести пометку набора — 'ph:car'
 * (иконка каталога), 'fl:1f697' / 'nt:1f697' (эмодзи картинкой или шрифтом),
 * имя иконки кита ('receipt') или голый символ (старые записи). Рисует его
 * клиент компонентом `Glyph`, но иногда значок попадает в СТРОКУ, которую
 * собирает сервер (подпись рич-карточки, будущие push-уведомления, письма).
 *
 * Печатать значение как есть нельзя: в строке окажется «fl:1f697». Эта функция
 * возвращает то, что уместно в тексте: сам символ эмодзи — или пустую строку,
 * если значок контурный (нарисовать иконку в plain text невозможно).
 */
export function glyphToText(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v) return '';

  const hex = v.startsWith('fl:') || v.startsWith('nt:') ? v.slice(3) : null;
  if (hex) {
    try {
      return String.fromCodePoint(...hex.split('-').map((p) => parseInt(p, 16)));
    } catch {
      return '';
    }
  }

  // 'ph:car' — иконка каталога; голое ASCII-слово — имя иконки кита ('receipt').
  // И то и другое в тексте показать нечем.
  if (/^[\x20-\x7f]+$/.test(v)) return '';

  return v; // голый символ старых записей
}

/** Значок с пробелом-разделителем для склейки: `${glyphPrefix(icon)}${name}`. */
export function glyphPrefix(value: string | null | undefined): string {
  const t = glyphToText(value);
  return t ? `${t} ` : '';
}
