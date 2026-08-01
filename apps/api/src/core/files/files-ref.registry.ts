import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Резолвер доступа к файлу через привязанную сущность (модель Salesforce
 * ContentDocumentLink: «файл виден тому, кому видна запись»). Сервисы-потребители
 * регистрируют свой refType в onModuleInit (паттерн rich-cards.registry) — внутри
 * canView/canAttach они зовут свои проверки core/access (chat.view, task.view, ...).
 * Tuple-проекции у файлов НЕТ: родительская сущность — источник истины, проверка
 * выполняется на каждый доступ (как перепроверка прав на execute у rich-cards).
 */
export interface FileRefResolver {
  /** Может ли viewer видеть файлы, привязанные к refId */
  canView(viewerId: string, refId: string): Promise<boolean>;
  /** Может ли userId привязывать/отвязывать файлы к refId */
  canAttach(userId: string, refId: string): Promise<boolean>;
  /**
   * Может ли userId МЕНЯТЬ СОДЕРЖИМОЕ уже привязанного файла (движок документов:
   * «место даёт и просмотр, и правку»). Отдельный предикат, потому что canAttach у
   * мессенджера требует АВТОРСТВА сообщения — а общий .xlsx в чате правят все
   * участники, не только тот, кто его прислал.
   *
   * Не задан → откат на canAttach (остальные потребители не затронуты).
   */
  canEditContent?(userId: string, refId: string): Promise<boolean>;
  /**
   * Только для служебных привязок (anchorOnly): у файла не осталось НИ ОДНОГО настоящего
   * места. Владелец служебной связи обязан прибрать свою сущность и снять связь — после
   * этого движок доводит уборку файла до конца. Пока хук не снял связь, файл живёт.
   */
  onOrphaned?(refId: string): Promise<void>;
}

export interface FileRefOptions {
  /**
   * Какие профили (FILE_PROFILES) допустимо привязывать к этому refType. Движок
   * enforce'ит на linkFile/linkManyInTx: приватная сущность (задача/чат) не примет
   * публичный listing_image, чей вечный токен обошёл бы её приватность. undefined =
   * любой профиль (для обратной совместимости).
   */
  allowedProfiles?: string[];
  /**
   * СЛУЖЕБНАЯ привязка: местом файла не считается. Такую связь ставит движок сам себе
   * (core/docs пришивает 'document', чтобы черновик под открытым редактором не прибрал
   * реап сирот) — и она не должна навечно превращать файл в неприбираемый: удалили
   * сообщение с вложением, а якорь держит байты и квоту, хотя места больше нет.
   * При уборке движок считает сиротой файл, у которого не осталось НЕслужебных связей,
   * и зовёт onOrphaned владельцев якорей.
   */
  anchorOnly?: boolean;
}

/** Событие «файл привязали к сущности» — ровно то, что движок знает сам */
export interface FileLinkedEvent {
  fileId: string;
  refType: string;
  refId: string;
  role: string;
  /** Кто привязал (в linkManyInTx это всегда и загрузивший файл) */
  actorId: string;
}

/**
 * Наблюдатель ПРИВЯЗОК — глобальный, а не пер-refType.
 *
 * Резолвер принадлежит владельцу refType (мессенджеру, задачам), поэтому сервис,
 * которому интересны ЧУЖИЕ привязки, зарегистрироваться в нём не может. Отсюда
 * отдельный список наблюдателей: Диск подписывается один раз и сам решает, что
 * делать с файлом, только что появившимся в чате или задаче.
 *
 * Вызывается ВНУТРИ транзакции привязки, когда она есть (`tx`), — чтобы наблюдатель
 * мог поставить свой джоб тем же коммитом (transactional outbox): сообщение
 * отправилось ⇒ джоб есть, откатилось ⇒ джоба нет.
 *
 * Движок при этом ничего не знает о потребителях — тот же приём, что у
 * CallsRecordingRegistry и CalendarLayersRegistry.
 */
export interface FileLinkObserver {
  onLinked(tx: Prisma.TransactionClient | null, event: FileLinkedEvent): Promise<void>;
}

interface RegistryEntry {
  resolver: FileRefResolver;
  options: FileRefOptions;
}

@Injectable()
export class FilesRefRegistry {
  private readonly logger = new Logger(FilesRefRegistry.name);
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly observers = new Map<string, FileLinkObserver>();

  register(refType: string, resolver: FileRefResolver, options: FileRefOptions = {}): void {
    if (this.entries.has(refType)) {
      this.logger.warn(`resolver for "${refType}" already registered — overwriting`);
    }
    this.entries.set(refType, { resolver, options });
  }

  get(refType: string): FileRefResolver | undefined {
    return this.entries.get(refType)?.resolver;
  }

  options(refType: string): FileRefOptions | undefined {
    return this.entries.get(refType)?.options;
  }

  /** Подписаться на ЛЮБУЮ привязку файла (ключ — имя потребителя, повтор перезаписывает) */
  registerLinkObserver(key: string, observer: FileLinkObserver): void {
    this.observers.set(key, observer);
  }

  /**
   * Разослать событие наблюдателям. Ошибка одного не роняет ни остальных, ни
   * привязку: вложение в чате важнее, чем его копия на Диске. Оговорка — сбой
   * ЗАПРОСА внутри чужой транзакции всё равно отравит её, и коммит вызывающего
   * упадёт; это честно и лучше, чем наполовину применённая транзакция.
   */
  async notifyLinked(tx: Prisma.TransactionClient | null, event: FileLinkedEvent): Promise<void> {
    for (const [key, observer] of this.observers) {
      try {
        await observer.onLinked(tx, event);
      } catch (err) {
        this.logger.warn(
          `наблюдатель привязок "${key}" упал на ${event.refType}:${event.refId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
