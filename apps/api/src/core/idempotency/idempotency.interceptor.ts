import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Observable, defaultIfEmpty, from, lastValueFrom } from 'rxjs';
import { ZodError } from 'zod';
import type { Request, Response } from 'express';
import {
  IDEMPOTENCY_ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_LIMITS,
  IDEMPOTENT_REPLAYED_HEADER,
  SHOULD_RETRY_HEADER,
  isIdempotencyKey,
  type KeyScopeRef,
} from '@superapp/shared';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { ApiError, badRequest, conflict, unprocessable } from '../../shared/errors/api-error';
import {
  IDEMPOTENT_KEY,
  SKIP_IDEMPOTENCY_KEY,
  type IdempotentOptions,
} from '../../shared/decorators/idempotency.decorator';
import { IdempotencyFencedError, newBinding, runInternal, type IdemBinding } from '../../shared/idempotency/binding';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { idempotencyEnv, type IdempotencyPrincipalKind, type IdempotencyResult } from './idempotency.constants';
import { IdempotencyFingerprint, type FingerprintInput } from './idempotency.fingerprint';
import { IdempotencyMetrics } from './idempotency.metrics';
import { IdempotencyReplayRegistry, type ReplayRenderer } from './idempotency.replay.registry';
import { IdempotencyResponses } from './idempotency.responses';
import { IdempotencyStore, type ClaimInput, type IdemKeyRow } from './idempotency.store';

// ============================================================
// Жизненный цикл ключа повтора.
//
// Порядок несущий: интерцептор стоит ПОСЛЕ WorkspaceContext и ApiKeyAccess, то есть
// аутентификация, эпоха токена, скоуп ключа, согласия и ЧЛЕНСТВО отработали до поиска
// ключа — и отрабатывают на КАЖДОМ повторе. Отозвали доступ между попытками — повтор
// получит 403, а не сохранённый ответ.
// ============================================================

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Отказы, которые НИКОГДА не становятся финальными: повтор после них законен. */
const NEVER_FINAL_STATUSES = new Set<number>([
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
]);

/** Снимок: версия формата + исход. Тело хранится как ЕСТЬ, отказ — кодом и параметрами. */
interface OkSnapshot {
  v: 1;
  kind: 'ok';
  status: number;
  body: unknown;
}
interface ErrSnapshot {
  v: 1;
  kind: 'err';
  status: number;
  code: string;
  params?: Record<string, string | number | boolean>;
  details?: Record<string, unknown>;
}
type Snapshot = OkSnapshot | ErrSnapshot;

interface RequestLike extends Request {
  user?: JwtPayload;
}

interface Principal {
  kind: IdempotencyPrincipalKind;
  /** Часть скоупа «кто» */
  subject: string;
  /** Часть скоупа «чем» (id ключа API либо `session`) */
  keyPart: string;
  userId: string | null;
  apiKeyId: string | null;
  workspaceId: string | null;
}

/** Всё, что нужно знать о запросе с ключом (собирается один раз). */
interface KeyCtx {
  req: RequestLike;
  res: Response;
  method: string;
  route: string;
  options: IdempotentOptions;
  enforce: boolean;
  principal: Principal;
  scopeHash: Buffer;
  keyHash: Buffer;
  fpInput: FingerprintInput;
  leaseMs: number;
  atomic: boolean;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Префикс хэша ключа — единственное, что попадает в лог (сырой ключ не логируется НИКОГДА). */
const keyTag = (keyHash: Buffer) => keyHash.toString('hex').slice(0, 12);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly wsContext: WorkspaceContextService,
    private readonly store: IdempotencyStore,
    private readonly fingerprint: IdempotencyFingerprint,
    private readonly responses: IdempotencyResponses,
    private readonly replayRenderers: IdempotencyReplayRegistry,
    private readonly metrics: IdempotencyMetrics,
  ) {}

  intercept(execContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execContext.getType() !== 'http') return next.handle();
    return from(this.run(execContext, next));
  }

  // ------------------------------------------------------------
  // 1. Применим ли движок к этому запросу
  // ------------------------------------------------------------

  private async run(execContext: ExecutionContext, next: CallHandler): Promise<unknown> {
    const env = idempotencyEnv();
    if (env.mode === 'off') return this.plain(next);

    const http = execContext.switchToHttp();
    const req = http.getRequest<RequestLike>();
    const res = http.getResponse<Response>();
    const method = (req.method ?? '').toUpperCase();
    if (!MUTATION_METHODS.has(method)) return this.plain(next);

    const targets = [execContext.getHandler(), execContext.getClass()];
    if (this.reflector.getAllAndOverride<string>(SKIP_IDEMPOTENCY_KEY, targets)) return this.plain(next);
    const options = this.reflector.getAllAndOverride<IdempotentOptions>(IDEMPOTENT_KEY, targets) ?? {};
    const enforce = env.mode === 'enforce';

    // Повтор заголовка = двусмысленность, а не «возьмём первый»
    const rawHeader = req.headers?.[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    if (Array.isArray(rawHeader)) {
      if (!enforce) return this.plain(next);
      throw badRequest(IDEMPOTENCY_ERROR_CODES.keyInvalid);
    }
    const rawKey = typeof rawHeader === 'string' ? rawHeader.trim() : '';
    const principal = this.principalOf(req, options);

    if (!rawKey) {
      if (options.required && enforce && principal) throw badRequest(IDEMPOTENCY_ERROR_CODES.keyRequired);
      return this.plain(next);
    }
    if (!isIdempotencyKey(rawKey)) {
      if (!enforce) return this.plain(next);
      throw badRequest(IDEMPOTENCY_ERROR_CODES.keyInvalid);
    }
    // Ключ есть, а принципала нет (`@Public` без резолвера либо резолвер вернул null):
    // скоуп собрать не из чего — чужой ключ стал бы «невиданным». Идём мимо движка.
    if (!principal) return this.plain(next);

    const route = this.routeOf(req);
    const ctx: KeyCtx = {
      req,
      res,
      method,
      route,
      options,
      enforce,
      principal,
      scopeHash: sha256(
        [principal.subject, principal.keyPart, this.wsContext.get()?.activeWorkspaceId ?? '', method, route].join('\u0000'),
      ),
      keyHash: sha256(rawKey),
      fpInput: {
        method,
        route,
        params: (req.params ?? {}) as Record<string, unknown>,
        query: (req.query ?? {}) as Record<string, unknown>,
        // multipart разбирается ПОСЛЕ глобальных интерцепторов (multer — на уровне
        // ручки): тела мы ещё не видим. Такие запросы клиент не повторяет сам.
        body: this.isMultipart(req) ? undefined : req.body,
      },
      leaseMs: Math.max(5000, options.leaseMs ?? env.leaseMs),
      atomic: options.atomic === true,
    };

    try {
      return await this.withKey(execContext, next, ctx);
    } catch (err) {
      if (err instanceof IdempotencyStorageError) {
        // Хранилище движка недоступно ИМЕННО на запросе с ключом: клиент попросил
        // защиту, дать её мы не можем — честнее отказать, чем исполнить без защиты.
        // Запросы БЕЗ ключа этим не затронуты вовсе.
        this.logger.error(`idempotency storage failure on ${method} ${route}: ${err.reason}`);
        res.setHeader(SHOULD_RETRY_HEADER, 'true');
        throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: IDEMPOTENCY_ERROR_CODES.unavailable });
      }
      throw err;
    }
  }

  private plain(next: CallHandler): Promise<unknown> {
    return lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)));
  }

  // ------------------------------------------------------------
  // 2. Заявка, конфликт, исполнение
  // ------------------------------------------------------------

  private async withKey(execContext: ExecutionContext, next: CallHandler, c: KeyCtx): Promise<unknown> {
    const tag = await this.guarded(() => this.fingerprint.tag(c.fpInput));
    const claim: ClaimInput = {
      scopeHash: c.scopeHash,
      keyHash: c.keyHash,
      userId: c.principal.userId,
      principal: c.principal.kind,
      workspaceId: this.wsContext.get()?.activeWorkspaceId ?? null,
      apiKeyId: c.principal.apiKeyId,
      method: c.method,
      route: c.route,
      fingerprint: tag,
      atomic: c.atomic,
      leaseMs: c.leaseMs,
    };

    const claimed = await this.guarded(() => this.store.claim(claim));
    if (claimed) {
      this.metrics.request('new');
      return this.execute(execContext, next, c, claimed.attempt);
    }

    // Ключ уже известен: читаем строку БЕЗ блокировки — её может держать живая
    // транзакция первого исполнения, и ждать на ней означало бы висеть.
    const row = await this.guarded(() => this.store.seen(c.scopeHash, c.keyHash));
    if (!row) {
      // Строку смела чистка ровно между INSERT и SELECT — заявляемся заново
      const again = await this.guarded(() => this.store.claim(claim));
      if (!again) return this.refuse(c, next, 'in_flight');
      this.metrics.request('new');
      return this.execute(execContext, next, c, again.attempt);
    }

    // Эффекта не было — ключ свободен. Перезахват С ЗАМЕНОЙ отпечатка: человек
    // исправил форму и нажал ту же кнопку — это законно.
    if (row.state === 'released') {
      const taken = await this.guarded(() =>
        this.store.takeover(c.scopeHash, c.keyHash, row.attempt, { leaseMs: c.leaseMs, atomic: c.atomic, fingerprint: tag }),
      );
      if (!taken) return this.refuse(c, next, 'in_flight');
      this.metrics.request('takeover');
      return this.execute(execContext, next, c, taken.attempt);
    }

    // Тот же ключ с другой формой запроса — это ошибка клиента, а не повтор
    const sameForm = await this.guarded(() => this.fingerprint.verify(c.fpInput, row.fingerprint));
    if (!sameForm) {
      this.logger.warn(`idempotency key reused with a different request: ${c.method} ${c.route} key#${keyTag(c.keyHash)}`);
      return this.refuse(c, next, 'mismatch');
    }

    if (row.state === 'completed') return this.replay(c, row, next);
    // Эффект закоммичен, ответ собрать не успели (процесс умер до финализации)
    if (row.state === 'committed') return this.refuse(c, next, 'replay', row);

    // in_progress
    if (!row.lease_expired) return this.refuse(c, next, 'in_flight');
    if (!row.atomic && !c.atomic) {
      // Прошлая попытка умерла на неизвестном месте. Пере-исполнять нельзя: эффект
      // мог случиться. Человеку — «проверьте историю, прежде чем повторять».
      return this.refuse(c, next, 'unknown', row);
    }
    const taken = await this.guarded(() =>
      this.store.takeover(c.scopeHash, c.keyHash, row.attempt, { leaseMs: c.leaseMs, atomic: c.atomic }),
    );
    if (!taken) return this.refuse(c, next, 'in_flight');
    this.metrics.request('takeover');
    return this.execute(execContext, next, c, taken.attempt);
  }

  /**
   * Отказ движка + заголовки-подсказки клиенту. В режиме `observe` отказа нет:
   * считаем метрику и исполняем запрос как обычно — окно выката показывает, что
   * БЫЛО БЫ, ничего не ломая.
   */
  private refuse(c: KeyCtx, next: CallHandler, result: IdempotencyResult, row?: IdemKeyRow): Promise<unknown> {
    this.metrics.request(result);
    if (!c.enforce) return this.plain(next);
    switch (result) {
      case 'in_flight':
        c.res.setHeader('Retry-After', String(IDEMPOTENCY_LIMITS.retryAfterSec));
        c.res.setHeader(SHOULD_RETRY_HEADER, 'true');
        throw conflict(IDEMPOTENCY_ERROR_CODES.inFlight, undefined, { retryInSec: IDEMPOTENCY_LIMITS.retryAfterSec });
      case 'mismatch':
        c.res.setHeader(SHOULD_RETRY_HEADER, 'false');
        throw unprocessable(IDEMPOTENCY_ERROR_CODES.keyReused);
      case 'unknown':
        c.res.setHeader(SHOULD_RETRY_HEADER, 'false');
        throw conflict(IDEMPOTENCY_ERROR_CODES.outcomeUnknown, undefined, {
          ...(row?.resource_id ? { resourceId: row.resource_id } : {}),
        });
      default:
        c.res.setHeader(SHOULD_RETRY_HEADER, 'false');
        throw this.alreadyCompleted(row);
    }
  }

  private alreadyCompleted(row?: IdemKeyRow): ApiError {
    return conflict(IDEMPOTENCY_ERROR_CODES.alreadyCompleted, undefined, {
      ...(row?.resource_id ? { resourceId: row.resource_id } : {}),
      ...(row?.http_status ? { completedStatus: row.http_status } : {}),
    });
  }

  // ------------------------------------------------------------
  // 3. Исполнение под заявкой
  // ------------------------------------------------------------

  private async execute(execContext: ExecutionContext, next: CallHandler, c: KeyCtx, attempt: number): Promise<unknown> {
    const requestCtx = this.wsContext.get();
    const binding: IdemBinding = newBinding(c.scopeHash, c.keyHash, attempt);
    if (requestCtx) requestCtx.idem = binding;

    // Долгая ручка не должна терять аренду: продлеваем, пока обработчик жив. Смерть
    // процесса heartbeat не переживёт — в этом и смысл аренды.
    const beat = setInterval(
      () => void this.store.heartbeat(c.scopeHash, c.keyHash, attempt, c.leaseMs).catch(() => undefined),
      Math.max(1000, Math.min(IDEMPOTENCY_LIMITS.heartbeatMs, Math.floor(c.leaseMs / 3))),
    );
    if (typeof beat.unref === 'function') beat.unref();

    try {
      const value = await lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)));
      clearInterval(beat);
      // Сбой САМОГО движка на финализации не вправе отменить УЖЕ СЛУЧИВШИЙСЯ эффект:
      // человек получает свой ответ, строка остаётся `committed`, и повтор честно
      // увидит `already_completed`. Обратное — превратить успех в 500 — хуже во всём.
      // Исключение — нарушенное обещание `atomic` в development: его надо увидеть.
      try {
        await this.onSuccess(execContext, c, binding, attempt, value);
      } catch (err) {
        if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') throw err;
        this.logger.error(`idempotency finalize failed on ${c.method} ${c.route}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return value;
    } catch (err) {
      clearInterval(beat);
      if (err instanceof IdempotencyFencedError) {
        // Транзакция откатилась: заявку перехватил другой процесс. Смотрим, чем
        // кончилось у него, и отвечаем правдой, а не «внутренней ошибкой».
        this.metrics.request('fenced');
        const row = await this.store.peek(c.scopeHash, c.keyHash).catch(() => null);
        if (row?.state === 'completed') return this.replay(c, row, next);
        c.res.setHeader('Retry-After', String(IDEMPOTENCY_LIMITS.retryAfterSec));
        c.res.setHeader(SHOULD_RETRY_HEADER, 'true');
        throw conflict(IDEMPOTENCY_ERROR_CODES.inFlight, undefined, { retryInSec: IDEMPOTENCY_LIMITS.retryAfterSec });
      }
      // То же и на отказе: своя ошибка движка не должна подменить причину отказа,
      // которую ждёт клиент
      try {
        await this.onFailure(c, binding, attempt, err);
      } catch (inner) {
        this.logger.error(`idempotency finalize failed on ${c.method} ${c.route}: ${inner instanceof Error ? inner.message : String(inner)}`);
      }
      throw err;
    } finally {
      clearInterval(beat);
      if (requestCtx) requestCtx.idem = undefined;
    }
  }

  /** Успех: был ли НАБЛЮДАЕМЫЙ эффект? Да — снимаем ответ; нет — отпускаем ключ. */
  private async onSuccess(
    execContext: ExecutionContext,
    c: KeyCtx,
    binding: IdemBinding,
    attempt: number,
    value: unknown,
  ): Promise<void> {
    await runInternal(async () => {
      // Обещание `atomic` проверяется на КАЖДОМ успехе: НЕ БОЛЕЕ одной отмеченной
      // транзакции и ни одной записи мимо неё. Иначе пере-исполнение после обрыва
      // (которое разрешает именно это обещание) удвоило бы эффект.
      //
      // Ноль транзакций — законный исход: ручка ничего не сделала (второй ремень
      // денег погасил дубль проводки, состояние уже было нужным). Это как раз
      // безопасный случай, и объявлять его нарушением значило бы ронять ручку
      // ровно там, где защита СРАБОТАЛА.
      if (c.options.atomic && (binding.markedTx > 1 || binding.dirty)) {
        this.metrics.atomicViolation(`${c.method} ${c.route}`);
        const msg = `idempotency: handler ${c.method} ${c.route} declares atomic:true but committed ${binding.markedTx} marked transaction(s)${binding.dirty ? ' and wrote outside them' : ''}`;
        this.logger.error(msg);
        if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') throw new Error(msg);
      }

      const observable =
        binding.state === 'bound' || binding.dirty || c.options.required === true || c.options.effects === 'external';
      if (!observable) {
        // Read-only POST (поиск, предпросмотр, валидация): защищать нечего
        await this.store.release(c.scopeHash, c.keyHash, attempt);
        this.metrics.request('released');
        return;
      }

      const status = this.successStatus(execContext, c.method);
      let saved: { id: bigint; at: Date } | null = null;
      if (c.options.store !== 'none' && !this.isRaw(value)) {
        const snapshot: OkSnapshot = { v: 1, kind: 'ok', status, body: value };
        const text = safeStringify(snapshot);
        // Тело не сериализуется (циклы, глубина, BigInt) — значит снимка не будет,
        // и повтор ответит `already_completed`. Ронять УЖЕ СЛУЧИВШИЙСЯ эффект нельзя.
        if (text !== null) saved = await this.responses.save(this.cipherScope(c.principal), text);
      }
      await this.store.complete(c.scopeHash, c.keyHash, attempt, {
        httpStatus: status,
        errorCode: null,
        resourceId: this.resourceIdOf(value),
        responseId: saved?.id ?? null,
        responseAt: saved?.at ?? null,
      });
    });
  }

  /**
   * Отказ. Финальным он становится ТОЛЬКО если эффект уже закоммичен: иначе ключ
   * отпускается, и честный повтор с ИСПРАВЛЕННЫМ телом обязан пройти.
   *
   * 401/403/429 и ошибки формы финальными не становятся никогда: они говорят о
   * запросе, а не о состоянии мира, и повтор после них законен по определению.
   */
  private async onFailure(c: KeyCtx, binding: IdemBinding, attempt: number, err: unknown): Promise<void> {
    await runInternal(async () => {
      const committed = binding.state === 'bound' || binding.dirty;
      const status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      const neverFinal = err instanceof ZodError || NEVER_FINAL_STATUSES.has(status);
      if (!committed || neverFinal) {
        await this.store.release(c.scopeHash, c.keyHash, attempt);
        this.metrics.request('released');
        return;
      }
      const snap = this.errorSnapshot(err, status);
      const text = c.options.store === 'none' ? null : safeStringify(snap);
      const saved = text === null ? null : await this.responses.save(this.cipherScope(c.principal), text);
      await this.store.complete(c.scopeHash, c.keyHash, attempt, {
        httpStatus: snap.status,
        errorCode: snap.code,
        resourceId: null,
        responseId: saved?.id ?? null,
        responseAt: saved?.at ?? null,
      });
    });
  }

  // ------------------------------------------------------------
  // 4. Реплей
  // ------------------------------------------------------------

  private async replay(c: KeyCtx, row: IdemKeyRow, next: CallHandler): Promise<unknown> {
    if (!c.enforce) {
      this.metrics.request('replay');
      return this.plain(next);
    }

    // Сервис вправе перерисовать ответ по ссылке под ПРАВАМИ ЭТОГО запроса — тогда
    // повтор показывает свежее состояние, а не снимок трёхдневной давности.
    const renderer = this.replayRenderers.get(c.method, c.route);
    if (renderer && row.resource_id && row.http_status !== null && row.http_status < 400) {
      const fresh = await this.render(renderer, row.resource_id, c);
      // `undefined` — законный ответ рендерера «свежего вида нет» (сущность стёрли
      // мягким удалением, вид собрать не из чего): падаем обратно на снимок.
      if (fresh !== undefined) {
        this.metrics.request('replay');
        this.replayHeaders(c.res);
        return fresh;
      }
    }

    const stored =
      row.response_id !== null && row.response_at !== null && row.response_fresh
        ? await this.responses.load(this.cipherScope(c.principal), row.response_id, row.response_at)
        : null;
    this.metrics.request('replay');
    if (!stored) {
      c.res.setHeader(SHOULD_RETRY_HEADER, 'false');
      throw this.alreadyCompleted(row);
    }

    let snap: Snapshot;
    try {
      snap = JSON.parse(stored) as Snapshot;
    } catch {
      c.res.setHeader(SHOULD_RETRY_HEADER, 'false');
      throw this.alreadyCompleted(row);
    }
    this.replayHeaders(c.res);

    if (snap.kind === 'err') {
      // Отказ восстанавливается КОДОМ: фильтр соберёт фразу в языке ЭТОГО запроса —
      // повтор по-казахски не отдаст русский текст первой попытки.
      throw new ApiError(snap.status as HttpStatus, { code: snap.code, params: snap.params, details: snap.details });
    }
    // Статус успеха не переставляем: маршрут тот же, значит и код у Nest тот же,
    // что был записан в снимок (`@HttpCode` — метаданные ручки, не данные запроса).
    return snap.body;
  }

  /**
   * Перерисовка по ссылке. Отказ ДОСТУПА (404/403 от самого сервиса) — правильный
   * ответ повтора: права могли отозвать, и снимок здесь как раз врал бы. А вот
   * поломка рендерера (баг владельца данных) НЕ вправе превращать успешный повтор
   * в 500 — падаем обратно на снимок и шумим в лог.
   */
  private async render(renderer: ReplayRenderer, resourceId: string, c: KeyCtx): Promise<unknown> {
    try {
      return await renderer(resourceId, {
        userId: c.principal.userId,
        workspaceId: this.wsContext.get()?.activeWorkspaceId ?? null,
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `idempotency: replay renderer for ${c.method} ${c.route} failed, falling back to the snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  private replayHeaders(res: Response): void {
    res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    // Ответ собран из снимка и персонален — ни один посредник не вправе его хранить
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(SHOULD_RETRY_HEADER, 'false');
  }

  // ------------------------------------------------------------
  // Вспомогательное
  // ------------------------------------------------------------

  /** Любая ошибка ХРАНИЛИЩА движка — отдельный вид: наверху она станет 503, а не 500. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new IdempotencyStorageError(err instanceof Error ? err.message : String(err));
    }
  }

  private isMultipart(req: RequestLike): boolean {
    const ct = req.headers?.['content-type'];
    return typeof ct === 'string' && ct.toLowerCase().startsWith('multipart/form-data');
  }

  /** Ответ — байты/стрим: снимать нечего (ручка обязана нести `raw_response`). */
  private isRaw(value: unknown): boolean {
    return (
      value instanceof StreamableFile ||
      Buffer.isBuffer(value) ||
      (typeof value === 'object' && value !== null && typeof (value as { pipe?: unknown }).pipe === 'function')
    );
  }

  /** Шаблон маршрута (`/api/tasks/:id`) — он же часть скоупа: чужая ручка = чужой ключ. */
  private routeOf(req: RequestLike): string {
    const fromRoute = (req as unknown as { route?: { path?: string } }).route?.path;
    if (typeof fromRoute === 'string' && fromRoute.length) return fromRoute;
    // Запасной путь: живой адрес без строки запроса. Хуже как шаблон, но стабилен
    // в пределах одного клиента и никогда не расширяет скоуп.
    return (req.originalUrl ?? req.url ?? '/').split('?')[0]!;
  }

  private successStatus(execContext: ExecutionContext, method: string): number {
    const explicit = this.reflector.get<number>(HTTP_CODE_METADATA, execContext.getHandler());
    if (typeof explicit === 'number') return explicit;
    return method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
  }

  /** Ссылка на созданную сущность — её показывает `409 already_completed`. */
  private resourceIdOf(value: unknown): string | null {
    const data = (value as { data?: unknown } | undefined)?.data ?? value;
    const id = (data as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string') return id.slice(0, 128);
    return typeof id === 'number' ? String(id) : null;
  }

  private errorSnapshot(err: unknown, status: number): ErrSnapshot {
    if (err instanceof ApiError) {
      return { v: 1, kind: 'err', status, code: err.code, params: err.params, details: err.extra };
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const details = typeof body === 'object' && body !== null ? (body as { details?: { code?: string } }).details : undefined;
      // У наследного исключения кода может не быть — берём общий по статусу. Текст
      // НЕ сохраняем: он в одном языке, а повтор может прийти в другом.
      return { v: 1, kind: 'err', status, code: details?.code ?? legacyCodeFor(status) };
    }
    return { v: 1, kind: 'err', status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'internal' };
  }

  /**
   * Кто делает запрос. Человек и ключ API — из токена; `@Public`-ручка — из своего
   * резолвера (гость по токену ссылки, вебхук-триггер по своему секрету).
   * `sid` в скоуп НЕ входит НИКОГДА: он меняется на refresh, и тот же ключ после
   * обновления токена перестал бы узнаваться (урок Matrix).
   */
  private principalOf(req: RequestLike, options: IdempotentOptions): Principal | null {
    const user = req.user;
    if (user?.sub) {
      const kind: IdempotencyPrincipalKind = user.kind === 'bot' ? 'bot' : user.keyId ? 'api_key' : 'user';
      return {
        kind,
        subject: user.sub,
        keyPart: user.keyId ?? 'session',
        userId: user.sub,
        apiKeyId: user.keyId ?? null,
        workspaceId: user.keyWorkspaceId ?? null,
      };
    }
    const resolved = options.principal?.(req as never);
    if (!resolved) return null;
    return { kind: 'guest', subject: resolved, keyPart: 'public', userId: null, apiKeyId: null, workspaceId: null };
  }

  /**
   * Чьим KEK шифруется снимок: человек — своим (удаление аккаунта уносит ключ и
   * делает снимок нечитаемым сам собой), бот и ключ организации — ключом ОРГАНИЗАЦИИ,
   * гость — платформенным.
   */
  private cipherScope(p: Principal): KeyScopeRef {
    if ((p.kind === 'bot' || p.kind === 'api_key') && p.workspaceId) return { type: 'workspace', id: p.workspaceId };
    if (p.userId) return { type: 'user', id: p.userId };
    return { type: 'platform' };
  }
}

/** Сбой САМОГО хранилища движка (не бизнес-ошибка) — наверху станет 503 + X-Should-Retry. */
class IdempotencyStorageError extends Error {
  constructor(readonly reason: string) {
    super(`idempotency storage: ${reason}`);
    this.name = 'IdempotencyStorageError';
  }
}

/** JSON снимка либо `null`, если тело не сериализуется (цикл, глубина, BigInt). */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** Общий код отказа по статусу — зеркало `AllExceptionsFilter` для наследных исключений. */
function legacyCodeFor(status: number): string {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return 'http.notFound';
    case HttpStatus.CONFLICT:
      return 'http.conflict';
    default:
      return status >= 500 ? 'internal' : 'http.badRequest';
  }
}
