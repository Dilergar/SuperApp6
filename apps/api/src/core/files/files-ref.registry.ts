import { Injectable, Logger } from '@nestjs/common';

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

interface RegistryEntry {
  resolver: FileRefResolver;
  options: FileRefOptions;
}

@Injectable()
export class FilesRefRegistry {
  private readonly logger = new Logger(FilesRefRegistry.name);
  private readonly entries = new Map<string, RegistryEntry>();

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
}
