import { SetMetadata } from '@nestjs/common';
import type { KeyScopeService } from '@superapp/shared';

/**
 * Маршрут закрыт для ключей API (боты, личные ключи): только живая сессия человека.
 * Deny-by-default и так отвергает сервисы вне `KEY_SCOPE_SERVICES`; декоратор нужен
 * маршрутам ВНУТРИ открытого сервиса, которым ключ не положен (управление ключами,
 * смена пароля), и как документация намерения.
 */
export const NO_API_KEYS_KEY = 'noApiKeys';
export const NoApiKeys = () => SetMetadata(NO_API_KEYS_KEY, true);

/** Переопределить сервис скоупа, выведенный из префикса маршрута. */
export const KEY_SCOPE_KEY = 'keyScope';
export const KeyScope = (service: KeyScopeService) => SetMetadata(KEY_SCOPE_KEY, service);
