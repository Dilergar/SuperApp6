import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DatabaseService } from '../../shared/database/database.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private db: DatabaseService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // Verify user still exists
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, deletedAt: true, deletionScheduledAt: true },
    });

    // Block both permanently-anonymized and grace-window (pending) accounts —
    // a pending account is "gone" until the user logs in again to restore it.
    if (!user || user.deletedAt || user.deletionScheduledAt) {
      throw new UnauthorizedException('Пользователь не найден');
    }

    // role in JWT = system role (from login/refresh), kept for fast checks
    return payload;
  }
}
