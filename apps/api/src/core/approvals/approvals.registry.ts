import { Injectable, Logger } from '@nestjs/common';
import type { InboxItemDto, InboxScope } from '@superapp/shared';

/**
 * Предмет заявки глазами потребителя. Возвращает резолвер: движок сам не знает ни
 * документов, ни счетов, ни задач.
 */
export interface ApprovalRefContext {
  /** Название предмета — снимается в СНИМОК на строке заявки */
  title: string;
  /** Значок (ключ реестра иконок кита) */
  icon?: string;
  /** Организация, в которой живёт предмет; null у личных */
  workspaceId: string | null;
  /**
   * Отпечаток содержимого, под которым человек принимает решение. Пишется в КАЖДОЕ
   * решение: без него подпись ничего не доказывает — файл могли переписать после.
   * Потребитель без «содержимого» (согласование суммы в задаче) отдаёт null.
   */
  contentSha256?: string | null;
}

/**
 * Резолвер потребителя движка согласований. Регистрируется в onModuleInit своего
 * модуля (паттерн FilesRefRegistry/ShareLinksRegistry): движок не импортирует ни
 * один функциональный модуль, направление знания — только от потребителя к движку.
 *
 * Новый сервис получает согласование, подпись и ознакомление одной регистрацией:
 * стопка «Ждут решения», модалка, счётчик, рич-карточка в чате и журнал уже есть.
 */
export interface ApprovalRefProvider {
  /**
   * Контекст предмета при СОЗДАНИИ заявки — И ПРОВЕРКА ПРАВА на неё.
   *
   * Резолвер ОБЯЗАН вернуть null, если этот человек не вправе отправить предмет на
   * согласование: движок предметной области не знает и подтвердить право не может.
   * Раньше контракт говорил «право проверяет потребитель ДО вызова движка», и оба
   * живых резолвера честно ничего не проверяли — этого хватало ровно до тех пор,
   * пока существовал HTTP-путь мимо потребителя. Проверка живёт здесь, потому что
   * это единственное место, через которое проходит ЛЮБОЕ заведение заявки.
   *
   * Этот же метод зовётся при вынесении решения — за отпечатком `contentSha256`
   * той версии предмета, которую видит решающий.
   */
  describeForCreate(userId: string, refId: string): Promise<ApprovalRefContext | null>;

  /**
   * Может ли этот человек ВИДЕТЬ заявку. Зовётся для тех, кто не участник маршрута
   * и не автор (им доступ дан всегда) — например, руководитель, открывший карточку
   * документа. Отсутствует → видят только участники.
   */
  canView?(userId: string, refId: string): Promise<boolean>;

  /**
   * Актуальные подпись и ссылка на предмет. Зовётся при показе — в отличие от
   * снимка, здесь важно текущее состояние. null → предмет исчез (заявку всё равно
   * показываем: это история решений, и она переживает свой предмет).
   */
  describeRef?(refId: string): Promise<{ title: string; icon?: string; href?: string } | null>;

  /**
   * Решение по шагу ЗАПИСАНО (после коммита, best-effort). Нужен потребителям,
   * для которых само решение — юридический факт с последствиями: ознакомление
   * работника с приказом (ст. 23 п. 2 пп. 6 ТК РК) уходит в его личный архив.
   * Подписные шаги сюда НЕ приходят — их закрывает core/sign своим
   * `onActFinished` (у него уже есть акт и заявка); хук зовётся только на пути
   * обычного «решить кнопкой».
   */
  onDecided?(info: {
    refId: string;
    stepKind: 'approval' | 'signature' | 'acknowledgement';
    decision: 'approved' | 'rejected' | 'returned';
    userId: string;
  }): Promise<void>;
}

/**
 * Хук возврата к тому, кто ведёт заявку СНАРУЖИ. Регистрирует потребитель-ведущий
 * (движок Процессов), а не движок — то же направление, что у CallsRecordingRegistry.
 *
 * `originRef` для движка НЕПРОЗРАЧЕН: он не знает, что внутри лежит пара
 * «инстанс:шаг», и не должен знать.
 */
export interface ApprovalOriginProvider {
  onResolved(originRef: string, outcome: 'approved' | 'rejected' | 'returned'): Promise<void>;
}

/**
 * Источник стопки «Ждут решения».
 *
 * Стопка — ВИТРИНА, а не таблица: сегодня в ней один источник (заявки этого
 * движка), завтра рядом встанут очереди задач отдела из Процессов и приёмка работы
 * из Задачника — каждая одной регистрацией, без правок модалки и счётчика.
 * Поэтому элемент имеет общую форму `InboxItemDto`, и источник сам решает, какие
 * кнопки у него есть и куда ведёт «открыть целиком».
 */
export interface InboxSource {
  label: string;
  /** Только счётчик — путь бейджа, он не имеет права быть дорогим */
  count(userId: string, scope: InboxScope): Promise<number>;
  list(userId: string, limit: number, scope: InboxScope): Promise<InboxItemDto[]>;
  /**
   * Человек ВЫШЕЛ из организации (увольнение или выход) — снять с него открытые
   * задания этого источника. Обязанность решать не переживает членство: до
   * появления хука уволенный оставался адресатом кампании ознакомления, видел
   * её в стопке и НАВСЕГДА держал разовую кампанию незакрытой (в «Кадровых
   * сроках» она горела «не ознакомились 1»). Зовётся из общего каскада
   * увольнения вместе со снятием с шагов заявок; идемпотентно и best-effort.
   */
  releaseUser?(userId: string, workspaceId: string): Promise<void>;
}

@Injectable()
export class ApprovalsRegistry {
  private readonly logger = new Logger(ApprovalsRegistry.name);
  private readonly refs = new Map<string, ApprovalRefProvider>();
  private readonly origins = new Map<string, ApprovalOriginProvider>();
  private readonly sources = new Map<string, InboxSource>();

  register(refType: string, provider: ApprovalRefProvider): void {
    if (this.refs.has(refType)) this.logger.warn(`resolver for "${refType}" already registered — overwriting`);
    this.refs.set(refType, provider);
  }

  get(refType: string): ApprovalRefProvider | undefined {
    return this.refs.get(refType);
  }

  types(): string[] {
    return [...this.refs.keys()];
  }

  registerOrigin(originType: string, provider: ApprovalOriginProvider): void {
    if (this.origins.has(originType)) this.logger.warn(`origin "${originType}" already registered — overwriting`);
    this.origins.set(originType, provider);
  }

  getOrigin(originType: string): ApprovalOriginProvider | undefined {
    return this.origins.get(originType);
  }

  registerSource(key: string, source: InboxSource): void {
    if (this.sources.has(key)) this.logger.warn(`inbox source "${key}" already registered — overwriting`);
    this.sources.set(key, source);
  }

  /** Все источники стопки в порядке регистрации */
  sourceEntries(): [string, InboxSource][] {
    return [...this.sources.entries()];
  }
}
