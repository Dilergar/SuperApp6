import { Global, Module } from '@nestjs/common';
import { ChatterController } from './chatter.controller';
import { ChatterRefRegistry } from './chatter-ref.registry';
import { ChatterService } from './chatter.service';

/**
 * core/chatter — 9-й платформенный движок: «Хроника записи» — универсальная
 * лента «кто/что/когда + было → стало» на любой сущности (refType+refId).
 * @Global: доменные сервисы (Задачи, Организации, Сотрудники, …) пишут через
 * ChatterService.log в СВОЕЙ транзакции; доступ на чтение и chat-sink'и
 * потребители регистрируют в ChatterRefRegistry (onModuleInit, паттерн files/calls).
 * Плашки контекстных чатов = проекция записей джобами core/jobs (постановка в
 * той же транзакции; свой редрайв-крон движку больше не нужен).
 */
@Global()
@Module({
  controllers: [ChatterController],
  providers: [ChatterService, ChatterRefRegistry],
  exports: [ChatterService, ChatterRefRegistry],
})
export class ChatterModule {}
