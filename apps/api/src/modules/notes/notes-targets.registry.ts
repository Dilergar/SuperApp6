import { Injectable, Logger } from '@nestjs/common';
import type { NoteRelatedTargetType, NoteTargetSearchItemDto } from '@superapp/shared';

/** Описание цели для чипа в заметке и панели «Заметки» на карточке сущности */
export interface NoteTargetDescription {
  title: string;
  /** Дип-линк на карточку сущности (адрес несёт организацию) */
  url: string | null;
  /** Организация, которой принадлежит сущность (null — личная) */
  workspaceId: string | null;
}

export interface NoteTargetContext {
  /** Пространство заметок, из которого идёт запрос: null — личное */
  workspaceId: string | null;
}

/**
 * Что модуль-цель (Задачи, Контрагенты, Объекты, Документы) обязан уметь, чтобы к его
 * сущностям привязывались заметки. Права на цель решает ОН — реестр только зовёт.
 */
export interface NoteTargetResolver {
  /** Зритель видит сущность (привязать/показать панель можно только тогда) */
  canView(viewerId: string, targetId: string): Promise<boolean>;
  /** Заголовок и ссылка для чипа; null — сущности нет (или не видна) */
  describe(viewerId: string, targetId: string): Promise<NoteTargetDescription | null>;
  /** Кандидаты для пикера «Привязать к…» в контексте пространства (уже обрезаны правами) */
  search(viewerId: string, ctx: NoteTargetContext, q: string, limit: number): Promise<NoteTargetSearchItemDto[]>;
}

/**
 * Реестр целей привязки (паттерн DriveRoutingRegistry: направление импорта перевёрнуто —
 * модуль-цель импортирует NotesModule и регистрируется сам, Заметки про Задачи не знают).
 */
@Injectable()
export class NoteTargetRegistry {
  private readonly logger = new Logger(NoteTargetRegistry.name);
  private readonly resolvers = new Map<NoteRelatedTargetType, NoteTargetResolver>();

  register(targetType: NoteRelatedTargetType, resolver: NoteTargetResolver): void {
    if (this.resolvers.has(targetType)) this.logger.warn(`note target "${targetType}" already registered — overwriting`);
    this.resolvers.set(targetType, resolver);
  }

  get(targetType: string): NoteTargetResolver | undefined {
    return this.resolvers.get(targetType as NoteRelatedTargetType);
  }

  types(): NoteRelatedTargetType[] {
    return [...this.resolvers.keys()];
  }
}
