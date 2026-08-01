import { Injectable, Logger } from '@nestjs/common';

/**
 * Контекст объекта, на который выдаётся ссылка. Возвращает резолвер потребителя —
 * движок сам таблиц Диска, документов и будущих счетов не знает.
 */
export interface ShareRefContext {
  /** Владелец объекта: на него ложится ответственность за раздачу наружу */
  ownerType: 'user' | 'workspace';
  ownerId: string;
  /** Организация — для «Журнала организации»; у личных объектов null */
  workspaceId: string | null;
  /** Название объекта для управляющего интерфейса и записи в хронику */
  title: string;
}

/** То, что движок знает о ссылке, показывая её гостю */
export interface ShareLinkGuestContext {
  linkId: string;
  refType: string;
  refId: string;
  /** Пер-refType опции ссылки (v1 пусто; сюда ЭДО положит свои настройки подписания) */
  settings: Record<string, unknown>;
}

/**
 * Резолвер потребителя движка гостевых ссылок. Регистрируется в onModuleInit
 * своего модуля (паттерн FilesRefRegistry): движок не импортирует ни один
 * функциональный модуль, направление знания — только от потребителя к движку.
 *
 * Новый сервис получает «поделиться наружу» одной такой регистрацией — гостевая
 * страница, срок, отзыв, счётчик открытий и журнал визитов уже есть.
 */
export interface ShareLinkProvider {
  /**
   * Право УПРАВЛЯТЬ ссылками на этот объект (создать, отозвать, посмотреть журнал).
   * Планка — своя у каждого потребителя: у Диска это «управляющий узла», у
   * документов — владелец.
   *
   * Два разных отказа, и путать их нельзя:
   *  - `null` → движок отвечает 404. Это ответ ПОСТОРОННЕМУ: существование чужого
   *    объекта не подтверждаем даже фактом «нет прав».
   *  - брошенный `ForbiddenException` → 403 с настоящей причиной. Это ответ тому, кто
   *    объект ВИДИТ, но не управляет им. Ему 404 «Объект не найден» — прямая ложь: он
   *    смотрит на этот объект в своём же списке (на диске организации роль «правит»
   *    есть у каждого сотрудника, и весь блок ссылок наружу отвечал им «не найдено»).
   */
  authorizeManage(userId: string, refId: string): Promise<ShareRefContext | null>;

  /**
   * Что увидит гость. Зовётся на КАЖДЫЙ показ страницы, а не единожды при выдаче
   * ссылки: объект мог уехать в корзину или измениться. null → 410 «объект
   * недоступен» (движок не отзывает ссылку — из корзины объект ещё вернётся).
   */
  resolveGuestView(link: ShareLinkGuestContext): Promise<unknown | null>;

  /** Подпись объекта для будущей страницы «Мои ссылки» (в v1 не зовётся) */
  describeRef?(refId: string): Promise<{ title: string; icon?: string } | null>;

  // ЗАДЕЛ (не строим в v1): `actions?: Record<string, (link, body) => Promise<unknown>>`
  // + POST /share-links/guest/:token/actions/:key — подпись документа в ЭДО, оплата
  // счёта, отправка отзыва. Появится вместе с ПЕРВЫМ таким потребителем, а не
  // «на всякий случай»: пустой контракт без реализации только вводит в заблуждение.
}

@Injectable()
export class ShareLinksRegistry {
  private readonly logger = new Logger(ShareLinksRegistry.name);
  private readonly entries = new Map<string, ShareLinkProvider>();

  register(refType: string, provider: ShareLinkProvider): void {
    if (this.entries.has(refType)) {
      this.logger.warn(`provider for "${refType}" already registered — overwriting`);
    }
    this.entries.set(refType, provider);
  }

  get(refType: string): ShareLinkProvider | undefined {
    return this.entries.get(refType);
  }

  /** Зарегистрированные типы — для дев-диагностики и сообщений об ошибке */
  types(): string[] {
    return [...this.entries.keys()];
  }
}
