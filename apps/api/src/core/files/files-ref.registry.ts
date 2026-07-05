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
}

export interface FileRefOptions {
  /**
   * Какие профили (FILE_PROFILES) допустимо привязывать к этому refType. Движок
   * enforce'ит на linkFile/linkManyInTx: приватная сущность (задача/чат) не примет
   * публичный listing_image, чей вечный токен обошёл бы её приватность. undefined =
   * любой профиль (для обратной совместимости).
   */
  allowedProfiles?: string[];
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
