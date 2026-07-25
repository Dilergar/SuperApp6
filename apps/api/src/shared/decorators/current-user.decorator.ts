import { createParamDecorator, ExecutionContext } from '@nestjs/common';

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
