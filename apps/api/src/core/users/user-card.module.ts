import { Global, Module } from '@nestjs/common';
import { UserCardService } from './user-card.service';

/**
 * Карточка человека (`user.card` движка видимости) — @Global: её рисуют Окружение, ростер
 * организации, находимость по номеру, приглашения и Мессенджер; одна проекция на всех.
 */
@Global()
@Module({
  providers: [UserCardService],
  exports: [UserCardService],
})
export class UserCardModule {}
