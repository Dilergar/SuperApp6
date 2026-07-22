import { Injectable, Logger } from '@nestjs/common';
import { ChatterEntryDto } from '@superapp/shared';

/**
 * Реестр потребителей хроники (паттерн FilesRefRegistry/CallsRefRegistry):
 * движок core/chatter не импортирует фичевые модули — сервисы сами регистрируют
 * свой refType в onModuleInit.
 *
 * Две регистрации на refType:
 *  - резолвер canView — «видишь запись → видишь её хронику» (проверка на каждый
 *    доступ, tuple-проекции нет — родительская сущность = источник истины);
 *  - chat-sink (опционально) — проекция записи плашкой в контекстный чат сущности
 *    (регистрирует МЕССЕНДЖЕР, направление CallsRecordingRegistry). Записи с
 *    needsChatPost без синка ждут его регистрации (drain не клеймит).
 */
export interface ChatterRefResolver {
  /** Может ли viewer читать хронику записи refId */
  canView(viewerId: string, refId: string): Promise<boolean>;
}

export interface ChatterChatSink {
  /** Спроецировать запись хроники плашкой в чат сущности (идемпотентность — на клейме движка) */
  post(entry: ChatterEntryDto): Promise<void>;
}

@Injectable()
export class ChatterRefRegistry {
  private readonly logger = new Logger(ChatterRefRegistry.name);
  private readonly resolvers = new Map<string, ChatterRefResolver>();
  private readonly sinks = new Map<string, ChatterChatSink>();

  register(refType: string, resolver: ChatterRefResolver): void {
    if (this.resolvers.has(refType)) {
      this.logger.warn(`resolver for "${refType}" already registered — overwriting`);
    }
    this.resolvers.set(refType, resolver);
  }

  registerChatSink(refType: string, sink: ChatterChatSink): void {
    if (this.sinks.has(refType)) {
      this.logger.warn(`chat sink for "${refType}" already registered — overwriting`);
    }
    this.sinks.set(refType, sink);
  }

  get(refType: string): ChatterRefResolver | undefined {
    return this.resolvers.get(refType);
  }

  getSink(refType: string): ChatterChatSink | undefined {
    return this.sinks.get(refType);
  }

  /** refType'ы с зарегистрированным chat-sink (обход крона-редрайва) */
  sinkTypes(): string[] {
    return [...this.sinks.keys()];
  }
}
