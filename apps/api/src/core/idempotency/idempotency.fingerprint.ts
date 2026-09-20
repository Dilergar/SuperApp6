import { Injectable } from '@nestjs/common';
import { KeysMacService } from '../keys/keys.mac.service';
import { IDEMPOTENCY_MAC_NAME } from './idempotency.constants';

// ============================================================
// Отпечаток формы запроса.
//
// Тот же ключ с ДРУГИМ телом обязан получить 422, а не чужой ответ. Сравнивать
// тела напрямую нельзя (они не хранятся), поэтому хранится HMAC-тег движка ключей:
// подделать его снаружи нельзя, сверка — константного времени, `kid` едет в самой
// строке, значит ротация ключа безопасна.
//
// В отпечаток входит РАЗОБРАННОЕ тело — ровно тот объект, который увидит обработчик.
// Сырые байты не годятся: два JSON'а с одинаковым смыслом (порядок ключей, пробелы,
// дублированные ключи) разошлись бы отпечатком, а обработчик увидел бы одно и то же.
// ============================================================

/**
 * Канонизация JSON (RFC 8785, JCS): ключи объектов — по кодовым единицам UTF-16,
 * строки — в NFC (одна и та же буква из двух кодовых точек не должна расходиться),
 * без пробелов.
 *
 * ИТЕРАТИВНО, а не рекурсией: тело запроса бывает ОЧЕНЬ глубоким (документ заметки
 * с сотнями вложенных узлов), и рекурсивный обход ронял стек — а из движка это
 * выглядело как отказ хранилища, то есть `503` вместо честного отказа формы.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  // Литерал в стопке — готовый кусок вывода; объект `{ v }` — значение к обходу.
  // Части кладутся В ОБРАТНОМ порядке: стопка отдаёт их в прямом.
  const stack: Array<string | { v: unknown }> = [{ v: value }];
  while (stack.length) {
    const item = stack.pop()!;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const v = item.v;
    if (v === null || v === undefined) {
      out.push('null');
      continue;
    }
    const kind = typeof v;
    if (kind === 'number' || kind === 'boolean') {
      out.push(JSON.stringify(v) ?? 'null');
      continue;
    }
    if (kind === 'string') {
      out.push(JSON.stringify((v as string).normalize('NFC')));
      continue;
    }
    if (Array.isArray(v)) {
      out.push('[');
      stack.push(']');
      for (let i = v.length - 1; i >= 0; i--) {
        stack.push({ v: v[i] });
        if (i > 0) stack.push(',');
      }
      continue;
    }
    if (kind === 'object') {
      const src = v as Record<string, unknown>;
      // Сортировка по кодовым единицам UTF-16 (`<`), а НЕ localeCompare: язык не
      // участвует — иначе один и тот же объект канонизировался бы по-разному.
      const keys = Object.keys(src)
        .filter((k) => src[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.push('{');
      stack.push('}');
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!;
        stack.push({ v: src[k] });
        stack.push(':');
        stack.push(JSON.stringify(k.normalize('NFC')));
        if (i > 0) stack.push(',');
      }
      continue;
    }
    // bigint / symbol / function в разобранном JSON не встречаются; на всякий случай — строкой
    out.push(JSON.stringify(String(v)));
  }
  return out.join('');
}

/** Материал отпечатка: всё, что определяет СМЫСЛ запроса (заголовки — нет). */
export interface FingerprintInput {
  method: string;
  /** Шаблон маршрута (`/api/tasks/:id`), а не живой путь */
  route: string;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  /** Разобранное тело; `undefined` — тела нет либо оно не разбиралось (multipart) */
  body: unknown;
}

@Injectable()
export class IdempotencyFingerprint {
  constructor(private readonly mac: KeysMacService) {}

  /** Строка материала — одна на запрос; попадает в HMAC и больше никуда. */
  material(input: FingerprintInput): string {
    return [
      input.method.toUpperCase(),
      input.route,
      canonicalJson(input.params ?? {}),
      canonicalJson(input.query ?? {}),
      input.body === undefined ? '-' : canonicalJson(input.body),
    ].join('\n');
  }

  /** Самодостаточный тег `sa6m:1:<kid>:<hmac>` для колонки `fingerprint`. */
  tag(input: FingerprintInput): Promise<string> {
    return this.mac.tagged(IDEMPOTENCY_MAC_NAME, this.material(input));
  }

  /** Совпадает ли сохранённый тег с формой ЭТОГО запроса (константное время). */
  verify(input: FingerprintInput, stored: string): Promise<boolean> {
    return this.mac.verifyTagged(IDEMPOTENCY_MAC_NAME, this.material(input), stored);
  }
}
