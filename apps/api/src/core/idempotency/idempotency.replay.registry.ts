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

/** Ключ реестра — метод и ШАБЛОН маршрута (`POST /api/tasks`). */
export const replayRouteKey = (method: string, route: string) => `${method.toUpperCase()} ${route}`;

@Injectable()
export class IdempotencyReplayRegistry {
  private readonly renderers = new Map<string, ReplayRenderer>();

  register(method: string, route: string, renderer: ReplayRenderer): void {
    const key = replayRouteKey(method, route);
    if (this.renderers.has(key)) return; // повторная регистрация (HMR) — не ошибка
    this.renderers.set(key, renderer);
  }

  get(method: string, route: string): ReplayRenderer | undefined {
    return this.renderers.get(replayRouteKey(method, route));
  }

  get size(): number {
    return this.renderers.size;
  }
}
