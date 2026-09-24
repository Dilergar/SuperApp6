import { Injectable } from '@nestjs/common';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { DatabaseService } from '../../shared/database/database.service';
import { notFound, tooMany } from '../../shared/errors/api-error';
import { RedisService } from '../../shared/redis/redis.service';
import { VisibilityPersonalGraphRegistry } from './visibility.registry';

/** Потолок поисков человека по номеру от имени ОРГАНИЗАЦИИ в час (приглашения сотрудников). */
const WORKSPACE_LOOKUPS_PER_HOUR = 200;

/**
 * Находимость по номеру — ОТДЕЛЬНАЯ ось от видимости полей (решение грилла №9; Signal 2024,
 * Telegram 2019). Один страж на ВСЕ пути, принимающие номер: поиск в форме приглашения,
 * приглашения Окружения и организаций (пре-линк карточка), перевод по номеру, поиск людей.
 * `nobody` неотличим от «не найден» (тот же код, тот же ответ) — иначе оракул (Twitter 2022,
 * Telegram CVE-2019-15514). Тем, кто уже сохранил номер, человек виден всегда — движок не
 * обещает невозможного (подсказка в UI).
 */
@Injectable()
export class VisibilityDiscoverabilityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ctx: WorkspaceContextService,
    private readonly graph: VisibilityPersonalGraphRegistry,
  ) {}

  /**
   * Кто спрашивает по умолчанию — из контекста запроса: ключ API и бот людей по номеру не
   * находят никогда, даже если путь (приглашение, перевод) не передал вид зрителя явно.
   */
  private viewerKindFromContext(): 'user' | 'bot' {
    const actor = this.ctx.get()?.request?.actor;
    return actor?.keyId || actor?.kind === 'bot' ? 'bot' : 'user';
  }

  /**
   * Находит ли `viewerId` владельца номера `ownerId`: `everybody` — да; `circle` — только уже
   * связанный в Окружении; `nobody` — никто. Сам себя — да. Бот и гость — никогда.
   */
  async isDiscoverable(ownerId: string, viewerId: string | null, viewerKind?: 'user' | 'bot' | 'guest'): Promise<boolean> {
    if (!viewerId || (viewerKind ?? this.viewerKindFromContext()) !== 'user') return false;
    if (ownerId === viewerId) return true;
    const owner = await this.db.user.findUnique({ where: { id: ownerId }, select: { discoverableBy: true, deletedAt: true } });
    if (!owner || owner.deletedAt) return false;
    if (owner.discoverableBy === 'everybody') return true;
    if (owner.discoverableBy === 'nobody') return false;
    const rel = (await this.graph.get()?.relationsOf(viewerId, [ownerId]))?.get(ownerId);
    return !!rel?.linked;
  }

  /** Страж пути: не находим — тот же 404, что у «такого номера нет» на этом пути. */
  async assertDiscoverable(ownerId: string, viewerId: string | null, notFoundCode: string): Promise<void> {
    if (!(await this.isDiscoverable(ownerId, viewerId))) throw notFound(notFoundCode);
  }

  /** Пакетно: кого из владельцев номеров зритель находит (списки приглашений, поиск людей). */
  async filterDiscoverable(ownerIds: readonly string[], viewerId: string): Promise<Set<string>> {
    const ids = [...new Set(ownerIds)];
    const out = new Set<string>();
    if (!ids.length || this.viewerKindFromContext() !== 'user') return out;
    const owners = await this.db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, discoverableBy: true } });
    const needGraph: string[] = [];
    for (const o of owners) {
      if (o.id === viewerId || o.discoverableBy === 'everybody') out.add(o.id);
      else if (o.discoverableBy === 'circle') needGraph.push(o.id);
    }
    if (needGraph.length) {
      const rels = (await this.graph.get()?.relationsOf(viewerId, needGraph)) ?? new Map();
      for (const id of needGraph) if (rels.get(id)?.linked) out.add(id);
    }
    return out;
  }

  /**
   * Лимит поисков по номеру на ОРГАНИЗАЦИЮ (сверх личного 30/час): перебор базы номеров
   * ботнетом сотрудников одной организации (WhatsApp 2025 — 3,5 млрд без лимита).
   */
  async throttleWorkspaceLookup(workspaceId: string): Promise<void> {
    const key = `vis:lookup:ws:${workspaceId}:${Math.floor(Date.now() / 3_600_000)}`;
    try {
      const client = this.redis.getClient();
      const n = await client.incr(key);
      if (n === 1) await client.expire(key, 3600);
      if (n > WORKSPACE_LOOKUPS_PER_HOUR) throw tooMany('visibility.lookup_rate', undefined, { code: 'visibility.lookup_rate' });
    } catch (err) {
      if ((err as { getStatus?: () => number }).getStatus?.() === 429) throw err;
      /* Redis недоступен — личный лимит 30/час остаётся */
    }
  }
}
