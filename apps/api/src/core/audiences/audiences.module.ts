import { Global, Module } from '@nestjs/common';
import { isDevEnv } from '../../shared/config/env.validation';
import { AudiencesRegistry } from './audiences.registry';
import { AudiencesService } from './audiences.service';
import { AudiencesDevController } from './audiences.dev';

/**
 * core/audiences — 16-й платформенный движок: единый словарь и разворот АДРЕСАТОВ.
 *
 * До него четыре потребителя (кампании, массовые кадровые действия, шаги согласования,
 * гранты шаблонов) держали по копии разворота «отдел → люди» с тремя разными резолверами
 * и знали наизусть имена отношений проекции прав. Теперь одна карта, одни якоря
 * ($initiator/$subject/$self) и одни относительные виды оргструктуры (руководитель,
 * команда, руководитель объекта) — для всех витрин разом, включая будущую Ленту.
 *
 * @Global — потребители инжектят AudiencesService; владельцы данных регистрируют
 * резолверы в AudiencesRegistry (Contacts — `circle`, Staff — относительные виды).
 * Движок не импортирует ни один функциональный модуль (страж check-docs роняет CI).
 */
@Global()
@Module({
  controllers: isDevEnv() ? [AudiencesDevController] : [],
  providers: [AudiencesRegistry, AudiencesService],
  exports: [AudiencesRegistry, AudiencesService],
})
export class AudiencesModule {}
