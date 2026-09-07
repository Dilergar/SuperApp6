import { Injectable, Logger } from '@nestjs/common';
import type {
  NotificationDeviceProvider,
  NotificationRef,
  RichCardRefType,
} from '@superapp/shared';

// ============================================================
// Реестры движка — направление «фича → движок» (движок не импортирует модули).
// ============================================================

/** Устройство для push-драйвера (срез строки NotificationDevice). */
export interface PushDevice {
  id: string;
  userId: string;
  provider: NotificationDeviceProvider;
  token: string;
  subscription: Record<string, unknown> | null;
}

export interface PushMessage {
  title: string;
  body: string | null;
  /** Относительный адрес внутри приложения (`/notifications`, `/tasks/<id>`) */
  href: string;
  /** Строка ленты, которую клик помечает прочитанной (сводный push — без неё) */
  notificationId: string | null;
  /** Ключ реестра иконок (клиент подберёт картинку) */
  icon: string;
  /** Срок годности в секундах (FCM ttl); undefined — по умолчанию драйвера */
  ttlSec?: number;
  /** Замена недоставленного (FCM collapse_key) */
  collapseKey?: string;
}

export interface PushSendResult {
  ok: boolean;
  /** Подписка/токен мертвы (404/410) — устройство отключается сразу */
  gone?: boolean;
  providerMessageId?: string | null;
  error?: string;
}

/** Драйвер push одного провайдера: webpush (core) · expo/fcm — контракт, живой драйвер на mobile-этапе. */
export interface PushDriver {
  readonly provider: NotificationDeviceProvider;
  /** Настроен ли (ключи в env); иначе `skipped: driver_not_configured` */
  readonly live: boolean;
  send(device: PushDevice, message: PushMessage): Promise<PushSendResult>;
}

export interface ChatPostInput {
  chatId: string;
  eventId: string;
  type: string;
  /** Снимок текста в SOURCE_LOCALE (плашка перерисуется в языке читателя по type+payload) */
  text: string;
  payload: Record<string, unknown>;
  href: string | null;
  ref: NotificationRef | null;
  /** Есть рендер в core/rich-cards — постить живую карточку, а не текст */
  richCardType: RichCardRefType | null;
  actorId: string | null;
}

export interface ChatPostResult {
  ok: boolean;
  messageId?: string | null;
  /** Чата нет / он закрыт — постоянная ошибка, ретраить нечего */
  gone?: boolean;
  error?: string;
}

/** Канал `chat` — регистрирует мессенджер (системное сообщение или рич-карта в чат). */
export interface ChatDriver {
  readonly live: boolean;
  post(input: ChatPostInput): Promise<ChatPostResult>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  href: string | null;
}

/** Канал `email` — контракт без живой доставки (нет SMTP и верификации почты); в UI не показывается. */
export interface EmailDriver {
  readonly live: boolean;
  send(message: EmailMessage): Promise<{ ok: boolean; providerMessageId?: string | null; error?: string }>;
}

@Injectable()
export class NotificationChannelRegistry {
  private readonly logger = new Logger(NotificationChannelRegistry.name);
  private readonly pushDrivers = new Map<NotificationDeviceProvider, PushDriver>();
  private chatDriver: ChatDriver | null = null;
  private emailDriver: EmailDriver | null = null;

  registerPush(driver: PushDriver): void {
    if (this.pushDrivers.has(driver.provider)) {
      this.logger.warn(`push driver "${driver.provider}" already registered; overwriting`);
    }
    this.pushDrivers.set(driver.provider, driver);
  }

  push(provider: NotificationDeviceProvider): PushDriver | undefined {
    return this.pushDrivers.get(provider);
  }

  /** Хоть один живой push-драйвер (веб показывает тумблер браузерных уведомлений по этому флагу) */
  get pushLive(): boolean {
    for (const d of this.pushDrivers.values()) if (d.live) return true;
    return false;
  }

  registerChat(driver: ChatDriver): void {
    if (this.chatDriver) this.logger.warn('chat driver already registered; overwriting');
    this.chatDriver = driver;
  }

  chat(): ChatDriver | null {
    return this.chatDriver;
  }

  registerEmail(driver: EmailDriver): void {
    this.emailDriver = driver;
  }

  email(): EmailDriver | null {
    return this.emailDriver;
  }
}

/** Контекст сборки deep link (адрес обязан нести организацию — правило каркаса веба). */
export interface NotificationHrefContext {
  workspaceId: string | null;
}

/**
 * Резолвер объекта, на который ссылается уведомление. Регистрирует ВЛАДЕЛЕЦ сущности.
 * `canViewMany` — батчем (правило Jira: письмо только тем, у кого есть право видеть;
 * НЕ check() в цикле). Без регистрации отсева нет и deep link = только actionUrl продюсера.
 */
export interface NotificationRefResolver {
  /** Кто из адресатов видит объект — вернуть подмножество userIds */
  canViewMany(userIds: string[], refId: string): Promise<string[]>;
  /** Адрес существующей страницы объекта; null — страницы нет */
  href(ref: NotificationRef, ctx: NotificationHrefContext): string | null;
  /** Тип рич-карты, если объект рендерится в core/rich-cards (строка ленты раскрывается в карточку) */
  richCardType?: RichCardRefType;
}

@Injectable()
export class NotificationRefRegistry {
  private readonly logger = new Logger(NotificationRefRegistry.name);
  private readonly resolvers = new Map<string, NotificationRefResolver>();

  register(refType: string, resolver: NotificationRefResolver): void {
    if (this.resolvers.has(refType)) {
      this.logger.warn(`ref resolver "${refType}" already registered; overwriting`);
    }
    this.resolvers.set(refType, resolver);
  }

  get(refType: string): NotificationRefResolver | undefined {
    return this.resolvers.get(refType);
  }
}

/** «Онлайн ли человек в вебе» — регистрирует мессенджер (presence живёт у него). */
export interface PresenceProvider {
  isOnline(userIds: string[]): Promise<Set<string>>;
}

@Injectable()
export class PresenceProviderRegistry {
  private provider: PresenceProvider | null = null;

  register(provider: PresenceProvider): void {
    this.provider = provider;
  }

  /** Без провайдера все считаются офлайн — push уходит сразу. */
  async onlineOf(userIds: string[]): Promise<Set<string>> {
    if (!this.provider || userIds.length === 0) return new Set();
    try {
      return await this.provider.isOnline(userIds);
    } catch {
      return new Set();
    }
  }
}
