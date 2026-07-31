'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { CardSkinRender } from '@superapp/shared';

// ============================================================
// Движок скинов человека — резолвит скин, который КАЖДЫЙ человек надел ДЛЯ МЕНЯ,
// чтобы любая поверхность «человек» (грид окружения, список чатов, пикеры,
// участники задач, упоминания, поиск) показывала его одним вызовом.
//
// Точка резолва РОВНО ОДНА — `resolvePersonSkins`. Хук `usePersonSkin(s)` — тонкая
// обёртка над ней. Раньше параллельных путей было три (хук, свой запрос страницы
// «Окружения», кэш этого модуля), и у каждого была своя копия ответа: после покупки
// или смены скина `invalidatePersonSkins()` чистил модульный кэш, но снимок,
// который держала страница в state, оставался старым — грид жил на прошлом скине
// до перезагрузки.
//
// Три свойства единой точки:
//  • ПАЧКАМИ по CHUNK_SIZE id — все id уходят в query string GET-запроса, и на
//    окружении в 200+ человек одна строка упиралась бы в лимит длины URL (414);
//  • МИКРО-БАТЧ в пределах тика — сотня смонтированных PersonAvatar просит скины
//    по одному, а сеть видит один (в худшем случае — по одному на пачку) запрос;
//  • КЭШ по userId + подписки по userId: повторный вызов не ходит в сеть, а ответ
//    будит только затронутые карточки (общий Set будил бы все сотни разом).
// ============================================================

/** Скин, готовый к отрисовке. Имя — для читаемости сигнатуры резолва. */
export type ResolvedSkin = CardSkinRender;

/**
 * Сколько id уходит в ОДИН GET. Ограничение не серверное, а транспортное: id —
 * это uuid (36 символов + запятая), 80 штук ≈ 3 КБ строки запроса — с запасом
 * влезает в общепринятый безопасный потолок ~8 КБ у прокси и серверов.
 */
const CHUNK_SIZE = 80;

/** userId → скин (null = «человек точно без скина», НЕ «ещё не знаем»). */
const cache = new Map<string, CardSkinRender | null>();
/** userId → промис пачки, которая его сейчас тянет (защита от дублей запросов). */
const inflight = new Map<string, Promise<void>>();

// Очередь текущего тика: заявки копятся и уходят одним flush'ем.
let queue = new Set<string>();
let queueDone: Promise<void> | null = null;
let queueResolve: (() => void) | null = null;

/**
 * Поколение кэша. Ответ, отправленный ДО сброса (смена аккаунта, надевание
 * скина), в свежий кэш писать нельзя — он про прошлое состояние.
 */
let generation = 0;

// Подписки ПО userId: батч-резолв будит только аватары затронутых людей.
// Общий Set будил бы КАЖДЫЙ смонтированный PersonAvatar/чип (на ростере в
// сотню карточек — сотни принудительных ре-рендеров на один ответ сети).
const subs = new Map<string, Set<() => void>>();
// Ids currently needed by mounted hooks (ref-counted) — so invalidate() can
// re-fetch exactly what's on screen instead of leaving it on the default skin.
const active = new Map<string, number>();

// Подписчики «кэш скинов сменился ЦЕЛИКОМ» — для потребителей, которые держат
// СВОЙ снимок карты (страница «Окружение» кладёт результат резолва в state).
// Без них надетый скин не доезжал бы до чужой копии до перезагрузки страницы.
const versionSubs = new Set<() => void>();
let version = 0;

function notify(ids: Iterable<string>) {
  const woken = new Set<() => void>();
  for (const id of ids) {
    const set = subs.get(id);
    if (!set) continue;
    for (const f of set) {
      if (!woken.has(f)) {
        woken.add(f);
        f();
      }
    }
  }
}

function notifyAll() {
  notify([...subs.keys()]);
  version += 1;
  for (const f of [...versionSubs]) f();
}

function uniqueIds(userIds: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of userIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function chunk(ids: string[], size: number): string[][] {
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  return parts;
}

async function fetchChunk(ids: string[], gen: number): Promise<void> {
  try {
    const res = await api.get('/card-skins/resolve', { params: { userIds: ids.join(',') } });
    // Ответ прошлого поколения (успели разлогиниться или надеть другой скин) —
    // в кэш не пишем, иначе свежий кэш наполнился бы устаревшими скинами.
    if (gen !== generation) return;
    const map = (res.data?.data ?? {}) as Record<string, CardSkinRender | null>;
    for (const id of ids) cache.set(id, map[id] ?? null);
  } catch {
    // Сеть моргнула — НЕ кэшируем null (это запинало бы человека на базовом скине
    // навсегда); id остаются неизвестными, и следующий вызов их перезапросит.
  }
}

async function flush(): Promise<void> {
  const ids = [...queue];
  const mine = queueDone;
  const done = queueResolve;
  queue = new Set();
  queueDone = null;
  queueResolve = null;
  const gen = generation;
  try {
    await Promise.all(chunk(ids, CHUNK_SIZE).map((part) => fetchChunk(part, gen)));
  } finally {
    // Снимаем только СВОИ метки: после сброса кэша те же id могли уже уехать в
    // новую пачку, и чужую метку стирать нельзя (иначе будет дубль запроса).
    for (const id of ids) if (inflight.get(id) === mine) inflight.delete(id);
    notify(ids);
    done?.();
  }
}

/**
 * Ставит недостающие id в очередь тика и отдаёт промисы, которых надо дождаться.
 * Уже известные (в кэше) не запрашиваются повторно.
 */
function schedule(ids: string[]): Promise<void>[] {
  const waits: Promise<void>[] = [];
  const seen = new Set<Promise<void>>();
  for (const id of ids) {
    if (cache.has(id)) continue;
    let p = inflight.get(id);
    if (!p) {
      let batch = queueDone;
      if (!batch) {
        batch = new Promise<void>((res) => { queueResolve = res; });
        queueDone = batch;
        // setTimeout(0), а не микротаск: собираем заявки ВСЕХ карточек, которые
        // монтируются в этом кадре, а не только синхронных соседей.
        setTimeout(() => void flush(), 0);
      }
      queue.add(id);
      p = batch;
      inflight.set(id, batch);
    }
    if (!seen.has(p)) {
      seen.add(p);
      waits.push(p);
    }
  }
  return waits;
}

/**
 * ЕДИНСТВЕННАЯ точка резолва скинов. Возвращает карту «userId → скин» ТОЛЬКО для
 * тех, у кого скин действительно есть: у остальных карточка рисует `DEFAULT_SKIN`,
 * и `map.get(id) === undefined` читается ровно так же, как отсутствие скина.
 *
 * Никогда не отклоняется: сбой сети = меньше записей в карте (и повторная попытка
 * при следующем вызове), а не упавший экран.
 */
export async function resolvePersonSkins(userIds: readonly string[]): Promise<Map<string, ResolvedSkin>> {
  const ids = uniqueIds(userIds);
  const waits = schedule(ids);
  if (waits.length > 0) await Promise.all(waits);
  const out = new Map<string, ResolvedSkin>();
  for (const id of ids) {
    const skin = cache.get(id);
    if (skin) out.set(id, skin);
  }
  return out;
}

/** Resolve skins for a set of people. Returns { userId: skin | null }. */
export function usePersonSkins(userIds: (string | undefined | null)[]): Record<string, CardSkinRender | null> {
  const [, force] = useState(0);
  const ids = uniqueIds(userIds);
  const key = ids.join(',');

  useEffect(() => {
    const cb = () => force((n) => n + 1);
    for (const id of ids) {
      let set = subs.get(id);
      if (!set) {
        set = new Set();
        subs.set(id, set);
      }
      set.add(cb);
    }
    retain(ids);
    void resolvePersonSkins(ids);
    return () => {
      for (const id of ids) {
        const set = subs.get(id);
        if (set) {
          set.delete(cb);
          if (set.size === 0) subs.delete(id);
        }
      }
      release(ids);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const out: Record<string, CardSkinRender | null> = {};
  for (const id of ids) out[id] = cache.get(id) ?? null;
  return out;
}

/** Resolve the skin for a single person. */
export function usePersonSkin(userId?: string | null): CardSkinRender | null {
  const map = usePersonSkins([userId]);
  return userId ? map[userId] ?? null : null;
}

/**
 * Счётчик сброса кэша. Нужен потребителям, которые держат СВОЙ снимок результата
 * `resolvePersonSkins` (страница кладёт карту в state): положив это число в
 * зависимости эффекта, страница перезапрашивает скины сразу после надевания —
 * иначе её копия живёт до перезагрузки.
 */
export function usePersonSkinsVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const cb = () => setV(version);
    versionSubs.add(cb);
    cb(); // на случай сброса между рендером и подпиской
    return () => { versionSubs.delete(cb); };
  }, []);
  return v;
}

function retain(ids: string[]) {
  for (const id of ids) active.set(id, (active.get(id) ?? 0) + 1);
}
function release(ids: string[]) {
  for (const id of ids) {
    const n = (active.get(id) ?? 0) - 1;
    if (n <= 0) active.delete(id);
    else active.set(id, n);
  }
}

/**
 * Drop the cache (e.g. right after the user equips/unequips a skin) AND
 * immediately re-fetch every skin still on screen, so avatars refresh in place
 * instead of falling back to the default until the next remount.
 */
export function invalidatePersonSkins() {
  cache.clear();
  inflight.clear();
  queue = new Set();
  // Поколение вперёд: ответы, отправленные ДО надевания, несут прошлый скин —
  // без этого они успевали бы приземлиться в свежий кэш и «откатить» смену.
  generation += 1;
  void resolvePersonSkins([...active.keys()]);
  notifyAll();
}

/**
 * Полный сброс при СМЕНЕ ПОЛЬЗОВАТЕЛЯ (выход из аккаунта). В отличие от
 * invalidatePersonSkins НЕ перезапрашивает: скины резолвятся «для меня», и повторный
 * запрос ушёл бы уже без токена. Кэш модульный и без TTL — не почистив его, следующий
 * вошедший в этой же вкладке увидел бы скины, разрешённые предыдущему.
 */
export function resetPersonSkins() {
  cache.clear();
  inflight.clear();
  queue = new Set();
  active.clear();
  generation += 1;
  notifyAll();
}
