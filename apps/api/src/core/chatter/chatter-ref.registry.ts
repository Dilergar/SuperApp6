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
  /**
   * Поля записи под правилами видимости (core/visibility): «было → стало» таких полей
   * маскируется ПРИ ЧТЕНИИ глазами зрителя (запись вечна и хранит факт; оклад, контакты
   * клиента не утекают через историю). Нет спеки — хроника типа без полей ≥ personal.
   */
  visibility?: ChatterVisibilitySpec;
}

/** Как поля хроники refType соотносятся с типом записи движка видимости. */
export interface ChatterVisibilitySpec {
  recordType: string;
  /** `change.field` хроники → ключ поля реестра видимости */
  fieldMap: Readonly<Record<string, string>>;
  /** Запись видимости по строке хроники (субъект — для «сам»/руководитель) */
  refOf(entry: { refId: string; workspaceId: string | null }): { recordId: string; subjectId: string | null; workspaceId: string | null; branchId?: string | null };
}

/** Изменение хроники в том виде, в котором его маскирует движок видимости. */
export interface ChatterMaskableChange {
  field: string;
  label?: string;
  from: string | null;
  to: string | null;
  raw?: unknown;
  concealed?: 'masked' | 'hidden';
}

/**
 * Порт маскировщика — регистрирует core/visibility (хроника не импортирует движок видимости:
 * тот сам пишет в хронику, прямое ребро дало бы цикл модулей). Нет маскировщика — поля со
 * спекой скрываются целиком (fail-closed).
 */
export interface ChatterMasker {
  mask<C extends ChatterMaskableChange>(viewerId: string, spec: ChatterVisibilitySpec, entry: { refId: string; workspaceId: string | null }, changes: C[]): Promise<C[]>;
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

  private masker: ChatterMasker | null = null;

  /** core/visibility: маскировщик «было → стало» при чтении хроники. */
  registerMasker(masker: ChatterMasker): void {
    this.masker = masker;
  }

  getMasker(): ChatterMasker | null {
    return this.masker;
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
