import { Injectable } from '@nestjs/common';

/**
 * Перерисовка ответа на повторе — ПО ССЫЛКЕ и под правами ТЕКУЩЕГО запроса.
 *
 * Снимок 72-часовой давности показывает состояние на момент первого исполнения.
 * Сервису, которому это вредно (карточка со статусом успела измениться), довольно
 * зарегистрировать рендерер: движок отдаст свежую сущность вместо снимка, а права
 * проверит сам сервис — тем же способом, что и на обычном чтении.
 *
 * Регистрирует ВЛАДЕЛЕЦ данных в своём `onModuleInit` (направление «фича → движок»).
 */
export interface ReplayContext {
  userId: string | null;
  workspaceId: string | null;
}

export type ReplayRenderer = (resourceId: string, ctx: ReplayContext) => Promise<unknown>;

/** Что шлюз видит от запроса (ровно то же, что и `principal`-резолвер ручки). */
export interface ReplayGateRequest {
  headers?: Record<string, unknown>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Шлюз повторной авторизации `@Public`-ручки. Бросает отказ (HTTP-исключение), если
 * доступа БОЛЬШЕ НЕТ; молча возвращается, если он есть.
 *
 * Зачем. У человека с аккаунтом доступ проверяют гарды — они стоят ДО интерцептора и
 * отрабатывают на каждом повторе. У гостя и вебхук-триггера гардов нет: их авторизация
 * (живая ли ссылка, не отозвана ли, действует ли пропуск, включён ли триггер) живёт
 * ВНУТРИ обработчика — а повтор обработчик не зовёт. Без шлюза отозванная ссылка ещё
 * трое суток отдавала бы сохранённый ответ: «жёсткий отзыв» переставал быть жёстким.
 */
export type ReplayGate = (req: ReplayGateRequest) => Promise<void>;

/** Ключ реестра — метод и ШАБЛОН маршрута (`POST /api/tasks`). */
export const replayRouteKey = (method: string, route: string) => `${method.toUpperCase()} ${route}`;

@Injectable()
export class IdempotencyReplayRegistry {
  private readonly renderers = new Map<string, ReplayRenderer>();
  private readonly gates = new Map<string, ReplayGate>();

  register(method: string, route: string, renderer: ReplayRenderer): void {
    const key = replayRouteKey(method, route);
    if (this.renderers.has(key)) return; // повторная регистрация (HMR) — не ошибка
    this.renderers.set(key, renderer);
  }

  get(method: string, route: string): ReplayRenderer | undefined {
    return this.renderers.get(replayRouteKey(method, route));
  }

  /**
   * Шлюз обязателен для КАЖДОЙ ручки с `principal`-резолвером: ручка называет его
   * именем (`@Idempotent({ principal, gate: 'share.guestAction' })`), владелец
   * регистрирует под тем же именем в своём `onModuleInit`, а страж маршрутов роняет
   * бут, если имя не названо либо не зарегистрировано. Имя, а не путь: опечатка в
   * пути молча выключила бы проверку, опечатка в имени — не даст подняться.
   */
  registerGate(name: string, gate: ReplayGate): void {
    if (this.gates.has(name)) return; // повторная регистрация (HMR) — не ошибка
    this.gates.set(name, gate);
  }

  gate(name: string | undefined): ReplayGate | undefined {
    return name ? this.gates.get(name) : undefined;
  }

  get size(): number {
    return this.renderers.size;
  }

  get gateCount(): number {
    return this.gates.size;
  }

  /** Ключи рендереров (`POST /api/tasks`) — страж маршрутов сверяет их с живыми ручками. */
  rendererKeys(): string[] {
    return [...this.renderers.keys()];
  }
}
