import { Injectable, Logger } from '@nestjs/common';

/**
 * Реестр доставки готовых записей звонка (точная копия паттерна CallsRefRegistry):
 * потребитель регистрирует свой refType в onModuleInit и получает СИНХРОННЫЙ хук
 * onReady на КАЖДОГО клейманта после финализации записи (файл уже в core/files).
 * Сегодня: RecorderModule для refType='chat' («Журнал звонков» Диктофона);
 * завтра: офис Ф3 для 'office_room' (протоколы встреч). Шина для доставки не
 * годится (at-most-once) — недоставленные клеймы редрайвит CallsCron.
 */
export interface CallRecordingReadyContext {
  recordingId: string;
  sessionId: string;
  refType: string;
  refId: string;
  /** FileObject готовой записи (владелец = включивший запись; файл ОБЩИЙ) */
  fileId: string;
  startedById: string;
  startedAt: Date;
  /** Кому доставляем (нажал «Получить запись»; инициатор клеймится сам) */
  claimantUserId: string;
}

export interface CallsRecordingHandler {
  /** Идемпотентно доставить запись клейманту (повтор при редрайве — не ошибка) */
  onReady(ctx: CallRecordingReadyContext): Promise<void>;
}

@Injectable()
export class CallsRecordingRegistry {
  private readonly logger = new Logger(CallsRecordingRegistry.name);
  private readonly entries = new Map<string, CallsRecordingHandler>();

  register(refType: string, handler: CallsRecordingHandler): void {
    if (this.entries.has(refType)) {
      this.logger.warn(`recording handler for "${refType}" already registered — overwriting`);
    }
    this.entries.set(refType, handler);
  }

  get(refType: string): CallsRecordingHandler | undefined {
    return this.entries.get(refType);
  }
}
