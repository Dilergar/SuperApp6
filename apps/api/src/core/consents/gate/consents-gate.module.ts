import { Global, Module } from '@nestjs/common';
import { ConsentsGateService } from './consents-gate.service';

/**
 * @Global по образцу SessionValidatorModule: шлюз нужен валидатору сессий (рукопожатие
 * сокета), глобальному гарду и интерцептору контекста организации. Зависит только от
 * базы и Redis — остальной движок (`ConsentsModule`) импортирует его, а не наоборот.
 */
@Global()
@Module({
  providers: [ConsentsGateService],
  exports: [ConsentsGateService],
})
export class ConsentsGateModule {}
