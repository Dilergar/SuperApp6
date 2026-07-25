import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SessionValidatorService } from '../../shared/auth/session-validator.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';

/**
 * HTTP-транспорт авторизации: извлечь Bearer + проверить подпись (passport-jwt).
 *
 * Вся логика «жива ли сессия» (поколение токенов, удалённые аккаунты, кэш) живёт в
 * SessionValidatorService — общем с рукопожатием веб-сокета. Раньше она была только
 * здесь, и сокет её не выполнял: отозванный токен не проходил в HTTP, но открывал
 * соединение и продолжал получать переписку.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private sessions: SessionValidatorService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  // role in JWT = system role (from login/refresh), kept for fast checks
  validate(payload: JwtPayload): Promise<JwtPayload> {
    return this.sessions.assertAlive(payload);
  }
}
