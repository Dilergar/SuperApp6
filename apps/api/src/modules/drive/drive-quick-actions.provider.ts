import { Injectable, OnModuleInit } from '@nestjs/common';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';

/**
 * Кнопки Диска в чате (+1 регистрация на действие — движок core/quick-actions):
 *
 *  • «Прикрепить с Диска» — в ＋-меню композера: выбрать свой файл и отправить его
 *    вложением. Чужой файл так прикрепить нельзя (движок требует авторства) —
 *    клиент в этом случае делится КАРТОЧКОЙ объекта.
 *  • «Сохранить на Диск» — в меню сообщения: положить вложение к себе. Свой файл
 *    ложится связью (те же байты), чужой — копией со своей квотой.
 *
 * Обе формы живут на клиенте; сюда попадает только объявление кнопки.
 */
@Injectable()
export class DriveQuickActionsProvider implements OnModuleInit {
  constructor(private readonly quickActions: QuickActionRegistry) {}

  onModuleInit(): void {
    this.quickActions.register({
      key: 'drive.attach',
      label: 'Прикрепить с Диска',
      icon: '🗂️',
      scopes: ['composer'],
      description: 'Отправить файл, который уже лежит на вашем Диске',
    });
    this.quickActions.register({
      key: 'drive.save',
      label: 'Сохранить на Диск',
      icon: '📥',
      scopes: ['message'],
      description: 'Положить вложение к себе на Диск',
    });
  }
}
