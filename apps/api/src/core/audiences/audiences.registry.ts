import { Injectable, Logger } from '@nestjs/common';
import type { AudienceContext, AudienceKind, AudienceLabelPart } from '@superapp/shared';

/**
 * Резолвер одного вида адресата, зарегистрированный ВЛАДЕЛЬЦЕМ данных:
 *   - `circle` регистрирует ContactsModule (`resolveCircleMemberIds` — единственный
 *     законный разворот Группы);
 *   - `manager_of` / `subordinates_of` / `branch_head_of` регистрирует StaffModule
 *     (вертикаль оргструктуры считается только там).
 * Сам движок читает лишь `relationTuple` и `user_roles` — рёбер core → modules нет.
 */
export interface AudienceResolver {
  /**
   * Развернуть адресата в людей. `id` уже без якорей (движок подставил контекст).
   * `limit` — потолок потребителя + 1: превышение движок отличает от точного попадания.
   * Чужая организация / человек вне команды → пустой список (не ошибка).
   */
  resolve(id: string, ctx: AudienceContext, limit: number): Promise<string[]>;
  /**
   * Своя ФОРМА подписи вида: ключ каталога + имя сущности снимком («Группа «{name}»»,
   * «Руководитель объекта «{name}»»). Слова резолвер не отдаёт НИКОГДА — подпись
   * собирается при чтении в языке зрителя, а записанная словом застыла бы в языке
   * того, кто нажал кнопку (docs/i18n.md). null → подпись вида по умолчанию.
   */
  label?(id: string, ctx: AudienceContext): Promise<AudienceLabelPart | null>;
}

@Injectable()
export class AudiencesRegistry {
  private readonly logger = new Logger(AudiencesRegistry.name);
  private readonly resolvers = new Map<AudienceKind, AudienceResolver>();

  register(kind: AudienceKind, resolver: AudienceResolver): void {
    if (this.resolvers.has(kind)) {
      this.logger.warn(`audience resolver for "${kind}" already registered — overwriting`);
    }
    this.resolvers.set(kind, resolver);
  }

  get(kind: AudienceKind): AudienceResolver | undefined {
    return this.resolvers.get(kind);
  }

  kinds(): AudienceKind[] {
    return [...this.resolvers.keys()];
  }
}
