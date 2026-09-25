import { Injectable, Logger } from '@nestjs/common';
import { CONSENT_DOCUMENT_KEYS, CONSENT_KINDS, CONSENT_LIMITS, CONSENT_REDIS, type ConsentDocumentKey, type ConsentSubjectType } from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { RedisService } from '../../../shared/redis/redis.service';

/** Облегчённая строка версии — всё, что нужно шлюзу (текст не читается). */
export interface ConsentVersionLite {
  id: string;
  documentKey: ConsentDocumentKey;
  version: number;
  material: boolean;
  effectiveFrom: Date;
  publishedAt: Date | null;
  status: string;
}

export interface ConsentPendingLite {
  version: ConsentVersionLite;
  /** Какую версию субъект принимал раньше (живая приёмка с наибольшим номером) */
  acceptedVersion: number | null;
}

const USER_BLOCK_DOCS = CONSENT_DOCUMENT_KEYS.filter((k) => CONSENT_KINDS[k].gate === 'block');
const WORKSPACE_SOFT_DOCS = CONSENT_DOCUMENT_KEYS.filter((k) => CONSENT_KINDS[k].gate === 'soft');
/**
 * Обязательные документы человека БЕЗ шлюза новой версии (уведомления: политика оператора). Новая
 * версия такого документа не блокирует, но человек без ЕДИНОЙ живой приёмки обязан его принять:
 * аккаунт, восстановленный из грейса (все согласия отозваны удалением), и аккаунт, созданный до
 * движка, иначе навсегда остались бы без подтверждения «ознакомлен».
 */
const USER_REQUIRED_NOTICE_DOCS = CONSENT_DOCUMENT_KEYS.filter((k) => CONSENT_KINDS[k].subject === 'user' && CONSENT_KINDS[k].required && CONSENT_KINDS[k].gate !== 'block');

/**
 * Шлюз согласий — лёгкое ядро без зависимостей от остального движка (его держат валидатор
 * сессий, глобальный гард и интерцептор контекста организации).
 *
 * Правда шлюза — ДАТЫ, а не джоб: версия действует, когда `effectiveFrom <= now`. Глобальная
 * эпоха G = число существенных версий блокирующих документов, уже вступивших в силу. Она
 * монотонна (опубликованная версия не удаляется и не правится — триггер базы) и считается из
 * крошечной таблицы версий с микрокэшем в процессе: Redis может быть сброшен, джоб активации —
 * опоздать, шлюз всё равно поднимется вовремя на каждом инстансе.
 *
 * У человека `users.consent_epoch` = G, до которой у него принято всё обязательное; значение
 * едет в кэше «аккаунт жив» рядом с tokenEpoch. Быстрый путь гарда — сравнение двух чисел
 * без ввода-вывода; отставший человек проверяется по базе (с коротким кэшем результата).
 */
@Injectable()
export class ConsentsGateService {
  private readonly logger = new Logger(ConsentsGateService.name);
  private cache: { at: number; versions: ConsentVersionLite[] } | null = null;
  private loading: Promise<ConsentVersionLite[]> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Сбросить микрокэш версий в ЭТОМ процессе (публикация, сид). Соседние инстансы догонят за `epochMicroCacheMs`. */
  invalidate(): void {
    this.cache = null;
  }

  /** Все опубликованные версии (включая заменённые и ещё не вступившие). */
  async publishedVersions(): Promise<ConsentVersionLite[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CONSENT_LIMITS.epochMicroCacheMs) return this.cache.versions;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const rows = await this.db.consentVersion.findMany({
          where: { status: { in: ['published', 'superseded'] } },
          select: { id: true, documentKey: true, version: true, material: true, effectiveFrom: true, publishedAt: true, status: true },
          orderBy: [{ documentKey: 'asc' }, { version: 'asc' }],
        });
        const versions = rows
          .filter((r): r is typeof r & { effectiveFrom: Date } => r.effectiveFrom !== null && Object.prototype.hasOwnProperty.call(CONSENT_KINDS, r.documentKey))
          .map((r) => ({ ...r, documentKey: r.documentKey as ConsentDocumentKey }));
        this.cache = { at: Date.now(), versions };
        return versions;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Действующая версия документа: вступившая в силу с наибольшим номером. */
  currentOf(versions: ConsentVersionLite[], key: ConsentDocumentKey, now = new Date()): ConsentVersionLite | null {
    let best: ConsentVersionLite | null = null;
    for (const v of versions) {
      if (v.documentKey !== key || v.effectiveFrom > now) continue;
      if (!best || v.version > best.version) best = v;
    }
    return best;
  }

  /** Опубликованные, но ещё не вступившие версии документа (баннер «принять заранее»). */
  upcomingOf(versions: ConsentVersionLite[], key: ConsentDocumentKey, now = new Date()): ConsentVersionLite[] {
    return versions.filter((v) => v.documentKey === key && v.effectiveFrom > now);
  }

  /**
   * «Пол» документа: номер последней СУЩЕСТВЕННОЙ вступившей версии. Принявший её (или более
   * позднюю) — чист; несущественные версии выше пола шлюз не поднимают.
   */
  floorOf(versions: ConsentVersionLite[], key: ConsentDocumentKey, now = new Date()): number | null {
    let floor: number | null = null;
    for (const v of versions) {
      if (v.documentKey !== key || !v.material || v.effectiveFrom > now) continue;
      if (floor === null || v.version > floor) floor = v.version;
    }
    return floor;
  }

  /** Глобальная эпоха человека: число существенных вступивших версий блокирующих документов. */
  async globalEpoch(): Promise<number> {
    const versions = await this.publishedVersions();
    const now = new Date();
    let n = 0;
    for (const v of versions) if (v.material && v.effectiveFrom <= now && CONSENT_KINDS[v.documentKey].gate === 'block') n++;
    return n;
  }

  private async softEpoch(): Promise<number> {
    const versions = await this.publishedVersions();
    const now = new Date();
    let n = 0;
    for (const v of versions) if (v.material && v.effectiveFrom <= now && CONSENT_KINDS[v.documentKey].gate === 'soft') n++;
    return n;
  }

  /**
   * Что субъект обязан принять ПРЯМО СЕЙЧАС (дата вступления прошла) и что опубликовано
   * на будущее. Считается по базе; вызывается на медленном пути и экранами согласий.
   */
  async pendingOf(subjectType: ConsentSubjectType, subjectId: string, client: Pick<DatabaseService, 'consentAcceptance'> = this.db): Promise<{ blocking: ConsentPendingLite[]; upcoming: ConsentPendingLite[] }> {
    const gated = subjectType === 'user' ? USER_BLOCK_DOCS : WORKSPACE_SOFT_DOCS;
    const docs = subjectType === 'user' ? [...gated, ...USER_REQUIRED_NOTICE_DOCS] : gated;
    const versions = await this.publishedVersions();
    const now = new Date();
    const live = await client.consentAcceptance.findMany({
      where: { subjectType, subjectId, documentKey: { in: docs }, revokedAt: null },
      select: { documentKey: true, versionId: true, version: { select: { version: true } } },
    });
    const acceptedMax = new Map<string, number>();
    const acceptedIds = new Set<string>();
    for (const a of live) {
      acceptedIds.add(a.versionId);
      const prev = acceptedMax.get(a.documentKey);
      if (prev === undefined || a.version.version > prev) acceptedMax.set(a.documentKey, a.version.version);
    }
    const blocking: ConsentPendingLite[] = [];
    const upcoming: ConsentPendingLite[] = [];
    for (const key of docs) {
      const accepted = acceptedMax.get(key) ?? null;
      const floor = this.floorOf(versions, key, now);
      const current = this.currentOf(versions, key, now);
      if (!gated.includes(key)) {
        // Уведомление: блокирует только полное отсутствие приёмки, новая версия — нет
        if (current && accepted === null) blocking.push({ version: current, acceptedVersion: null });
        continue;
      }
      if (floor !== null && current && (accepted === null || accepted < floor)) blocking.push({ version: current, acceptedVersion: accepted });
      for (const v of this.upcomingOf(versions, key, now)) {
        // Несущественная будущая версия принятия не требует — баннером не беспокоим
        if (!v.material || acceptedIds.has(v.id)) continue;
        upcoming.push({ version: v, acceptedVersion: accepted });
      }
    }
    return { blocking, upcoming };
  }

  /**
   * Медленный путь шлюза человека: эпоха отстала (или личности без эпохи — ключ API).
   * Результат кэшируется коротко с привязкой к G; чистый человек догоняет эпоху в базе,
   * и следующий запрос идёт быстрым путём.
   */
  async isUserBlocked(userId: string): Promise<boolean> {
    const g = await this.globalEpoch();
    if (g === 0) return false;
    const key = CONSENT_REDIS.gate(userId);
    try {
      const cached = await this.redis.cache.get(key);
      if (cached) {
        const [cg, flag] = cached.split(':');
        if (Number(cg) === g) return flag === '1';
      }
    } catch {
      /* Redis недоступен — считаем по базе */
    }
    const { blocking } = await this.pendingOf('user', userId);
    const blocked = blocking.length > 0;
    if (!blocked) await this.catchUp(userId, g);
    try {
      // «Заблокирован» держим коротко: человек принимает документы в эту же минуту
      await this.redis.cache.set(key, `${g}:${blocked ? 1 : 0}`, blocked ? 30 : CONSENT_LIMITS.pendingCacheSec);
    } catch {
      /* кэш — best-effort */
    }
    return blocked;
  }

  /** Догнать эпоху человека до G (только вперёд) и сбросить кэш «аккаунт жив», где она едет. */
  async catchUp(userId: string, g?: number, client: Pick<DatabaseService, 'user'> = this.db): Promise<void> {
    const epoch = g ?? (await this.globalEpoch());
    const { count } = await client.user.updateMany({ where: { id: userId, consentEpoch: { lt: epoch } }, data: { consentEpoch: epoch } });
    if (count > 0) await this.redis.cache.forget(`auth:alive:${userId}`);
  }

  /** Сбросить кэши шлюза человека (после приёмки/отзыва). Зовётся ПОСЛЕ коммита. */
  async forgetUser(userId: string): Promise<void> {
    await this.redis.cache.forget(CONSENT_REDIS.gate(userId), `auth:alive:${userId}`);
  }

  async forgetWorkspace(workspaceId: string): Promise<void> {
    await this.redis.cache.forget(CONSENT_REDIS.workspaceGate(workspaceId));
  }

  /** Мягкий шлюз организации: есть непринятые вступившие условия. */
  async isWorkspaceBlocked(workspaceId: string): Promise<boolean> {
    const g = await this.softEpoch();
    if (g === 0) return false;
    const key = CONSENT_REDIS.workspaceGate(workspaceId);
    try {
      const cached = await this.redis.cache.get(key);
      if (cached) {
        const [cg, flag] = cached.split(':');
        if (Number(cg) === g) return flag === '1';
      }
    } catch {
      /* Redis недоступен — считаем по базе */
    }
    const { blocking } = await this.pendingOf('workspace', workspaceId);
    const blocked = blocking.length > 0;
    try {
      await this.redis.cache.set(key, `${g}:${blocked ? 1 : 0}`, blocked ? 30 : CONSENT_LIMITS.pendingCacheSec);
    } catch {
      /* кэш — best-effort */
    }
    return blocked;
  }
}
