import { Injectable } from '@nestjs/common';
import type { KeysStepUpStatusDto } from '@superapp/shared';
import { StepUpService } from '../../verify/step-up.service';

/**
 * «Сильное подтверждение» для управления ключами (решение грилла №8): пароль + SMS-код
 * (цель `keys_manage`) → окно 15 минут. Сам механизм окна — общий `StepUpService`
 * (`core/verify`); ключи — его первый потребитель, этот класс — их узкая дверь.
 */
@Injectable()
export class KeysStepUpService {
  constructor(private readonly stepUp: StepUpService) {}

  status(userId: string): Promise<KeysStepUpStatusDto> {
    return this.stepUp.status(userId, 'keys_manage');
  }

  /** Окно открыто? Иначе 403 `keys.step_up_required` — клиент ведёт в шаг пароль → код. */
  assert(userId: string): Promise<void> {
    return this.stepUp.assert(userId, 'keys_manage');
  }

  confirm(userId: string, verifyToken: string): Promise<KeysStepUpStatusDto> {
    return this.stepUp.confirm(userId, 'keys_manage', verifyToken);
  }

  end(userId: string): Promise<void> {
    return this.stepUp.end(userId, 'keys_manage');
  }
}
