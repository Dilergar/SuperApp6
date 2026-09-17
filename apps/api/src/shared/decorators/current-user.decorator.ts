import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { KeyScopes } from '@superapp/shared';

export interface JwtPayload {
  sub: string; // user id
  phone: string;
  role: string;
  /**
   * Поколение токенов (users.token_epoch на момент выдачи). JwtStrategy отвергает
   * токен, у которого epoch отстал от текущего — так «отозвать все сессии» (сброс и
   * смена пароля, смена номера, logout-all) действительно отзывает выданные
   * access-токены, а не только строки session. Необязательное: токены, выпущенные
   * до появления поля, читаются как epoch=0 (= стартовое значение у всех аккаунтов),
   * поэтому раскатка никого не разлогинивает.
   */
  epoch?: number;
  /**
   * Идентификатор СТРОКИ сессии, из которой выпущен этот access-токен
   * (`sessions.id`). Чеканится вместе с refresh-строкой в `generateTokens`, поэтому
   * консистентен по построению и переживает ротацию (новая строка — новый `sid`).
   * Нужен, чтобы список устройств честно помечал «Текущая сессия». Необязательное:
   * токены, выпущенные до появления поля, дают `isCurrent=false` до первого refresh.
   */
  sid?: string;
  /**
   * Аудитория токена. У продуктового токена её нет; токен КАБИНЕТА платформы несёт
   * `aud: 'platform'` и подписан другим секретом — продуктовая стратегия отвергает
   * его явно, а не только по подписи (S1 плана кабинета).
   */
  aud?: string;
  /**
   * Личность по ключу API (core/keys): `bot` — теневой пользователь бота (`sub` = его
   * users.id), `user` — человек по личному ключу. Отсутствует у живой сессии.
   */
  kind?: 'user' | 'bot';
  keyId?: string;
  botId?: string | null;
  /** Организация ключа: боты и личные ключи данных организации; null — собственные данные человека */
  keyWorkspaceId?: string | null;
  /** Скоупы ключа — гард сверяет с сервисом маршрута; фактическое право = скоуп ∩ права носителя */
  scopes?: KeyScopes;
}

export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext): JwtPayload | JwtPayload[keyof JwtPayload] => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (data) {
      return user[data];
    }

    return user;
  },
);
