import type { TranslationValues } from './translator';
import type { Formatters } from './format';

// ============================================================
// СТРАНА В ВЕЧНОМ PAYLOAD.
//
// «Вход с нового устройства: Chrome · Windows, Казахстан» — страна приходит из
// гео-заголовка CDN кодом ISO (`KZ`) и лежит в payload уведомления и в событии
// журнала годами. Имя страны принадлежит ЯЗЫКУ ЗРИТЕЛЯ, поэтому продюсер пишет
// код с суффиксом `Country`:
//
//   payload: { whereCountry: 'KZ' }
//   каталог: "New sign-in: {device}, {where}"
//
// Рендер подставляет имя страны под именем БЕЗ суффикса (как `<имя>Iso`).
// Уже заданное имя без суффикса не перебивается; пустой код — значение не
// появляется, и каталог обязан это пережить (select по `unknown`, если нужно).
// ============================================================

const SUFFIX = 'Country';

export function resolveCountryValues(fmt: Pick<Formatters, 'country'>, values: TranslationValues): TranslationValues {
  let out: TranslationValues | null = null;
  for (const [name, value] of Object.entries(values)) {
    if (!name.endsWith(SUFFIX) || name.length === SUFFIX.length) continue;
    if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) continue;
    const target = name.slice(0, -SUFFIX.length);
    if (values[target] !== undefined) continue;
    out ??= { ...values };
    out[target] = fmt.country(value);
  }
  return out ?? values;
}
