import { Injectable, Logger } from '@nestjs/common';

/**
 * Реестр резолверов доступа к звонку через привязанную сущность (точная копия
 * паттерна FilesRefRegistry): сервисы-потребители регистрируют свой refType в
 * onModuleInit — внутри canJoin/canModerate они зовут свои проверки (роль воркспейса,
 * core/access, ...). Tuple-проекции у звонков НЕТ: сущность-родитель — источник
 * истины, проверка выполняется на каждую выдачу токена/модерацию.
 */
export interface CallsRefResolver {
  /** Может ли userId войти в звонок сущности refId (проверяется на КАЖДЫЙ токен) */
  canJoin(userId: string, refId: string): Promise<boolean>;
  /** Может ли userId модерировать (kick/mute/завершить для всех) */
  canModerate(userId: string, refId: string): Promise<boolean>;
  /**
   * Опц.: синхронный хук ПОСЛЕ успешной авторизации токена — чистое место
   * материализации участника у потребителя (шина at-most-once для этого не годится;
   * выдача токена — единственный путь в комнату, покрытие 100%).
   */
  onJoinAuthorized?(userId: string, refId: string, sessionId: string): Promise<void>;
  /** Опц.: workspaceId сущности — денормализуется в CallSession и payload событий */
  resolveWorkspaceId?(refId: string): Promise<string | null>;
}

@Injectable()
export class CallsRefRegistry {
  private readonly logger = new Logger(CallsRefRegistry.name);
  private readonly entries = new Map<string, CallsRefResolver>();

  register(refType: string, resolver: CallsRefResolver): void {
    if (this.entries.has(refType)) {
      this.logger.warn(`resolver for "${refType}" already registered — overwriting`);
    }
    this.entries.set(refType, resolver);
  }

  get(refType: string): CallsRefResolver | undefined {
    return this.entries.get(refType);
  }
}
