import { Injectable, Logger, OnApplicationBootstrap, Res } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, RESPONSE_PASSTHROUGH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, HttpAdapterHost, MetadataScanner, Reflector } from '@nestjs/core';
import { IDEMPOTENCY_SKIP_REASON_VALUES, IDEMPOTENCY_SKIP_REASONS } from '@superapp/shared';
import { IS_PUBLIC_KEY } from '../../shared/decorators/public.decorator';
import { IDEMPOTENT_KEY, SKIP_IDEMPOTENCY_KEY, type IdempotentOptions } from '../../shared/decorators/idempotency.decorator';
import { IdempotencyReplayRegistry, replayRouteKey } from './idempotency.replay.registry';

/**
 * `RouteParamtypes.RESPONSE` из Nest. Enum лежит во внутреннем пути пакета, поэтому
 * значение зафиксировано здесь, а на буте СВЕРЯЕТСЯ с живым декоратором (`ResProbe`
 * ниже): ключ метаданных аргументов — это строка `"<тип>:<индекс>"`. Сменит Nest
 * нумерацию — страж не ослепнет молча, а уронит старт.
 */
const RESPONSE_PARAMTYPE = 1;

/** Проба: что НА САМОМ ДЕЛЕ пишет `@Res()` в метаданные аргументов этой версии Nest. */
class ResProbe {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handler(@Res() _res: unknown): void {}
}

/**
 * `ALL` — тоже мутация: такая ручка принимает POST/PUT/PATCH/DELETE наравне с GET,
 * и интерцептор (он смотрит на метод ЗАПРОСА) её покрывает. Страж обязан видеть то же.
 */
const MUTATION_METHODS = new Set<RequestMethod>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
  RequestMethod.ALL,
]);

/** Слой роутера Express: ровно те поля, что нужны сверке рендереров. */
interface RouterLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

/**
 * Страж движка идемпотентности на буте (fail-closed, как страж скоупов ключей).
 * Падает, если автор ручки оставил движок в невозможном состоянии:
 *
 *  1. Мутация отдаёт ответ сама (`@Res()` без passthrough) — снимать нечего, значит
 *     ручка обязана нести `@SkipIdempotency('raw_response')`, а не молча ломать реплей;
 *  2. `required: true` на `@Public`-ручке без `principal`-резолвера — скоуп собрать
 *     не из чего, и «обязательный ключ» ничего не защищал бы;
 *  3. причина `@SkipIdempotency` вне закрытого списка — исключение без смысла;
 *  4. `@Public`-мутация без решения вовсе (ни `principal`, ни `@SkipIdempotency`) —
 *     ключ клиента на ней молча ничего не защищал бы;
 *  5. ручка с `principal`-резолвером без шлюза повторной авторизации (`gate`) либо с
 *     именем шлюза, под которым никто не зарегистрировался: повтор отдавал бы
 *     сохранённый ответ тому, у кого доступ уже отозвали;
 *  6. рендерер перерисовки зарегистрирован на маршрут, которого нет: опечатка в пути
 *     молча выключала бы перерисовку, и повтор отдавал бы снимок трёхдневной давности.
 */
@Injectable()
export class IdempotencyRoutesAudit implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyRoutesAudit.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly replayRenderers: IdempotencyReplayRegistry,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  onApplicationBootstrap(): void {
    const problems = this.problems();
    if (problems.length) {
      const msg = `idempotency: routes are declared inconsistently (see docs/idempotency_engine.md):\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    const c = this.coverage();
    this.logger.log(
      `idempotency route audit: ok — ${c.mutations} mutations, ${c.covered} covered ` +
        `(${c.required} require a key, ${c.storeNone} store nothing), ` +
        `${c.skipped} declared out (${c.byReason})` +
        (c.unscoped.length ? `, NOT protected (public without a principal resolver): ${c.unscoped.join(', ')}` : ', none unprotected') +
        // Перерисовка по ссылке — тоже часть картины: без неё повтор карточки со
        // статусом отдаёт снимок трёхдневной давности, и это видно только в логе.
        `; ${this.replayRenderers.size} replay renderer(s), ${this.replayRenderers.gateCount} replay gate(s)`,
    );
  }

  /**
   * Покрытие движка одной строкой на буте. Не страж, а ЧЕСТНАЯ КАРТИНА: сколько
   * мутаций защищено по умолчанию, сколько выведено и по каким причинам, и сколько
   * публичных ручек остались без принципала (то есть без защиты в принципе).
   * Без такой строки «покрыто всё» — вера, а не факт.
   */
  coverage(): {
    mutations: number;
    covered: number;
    required: number;
    storeNone: number;
    skipped: number;
    unscoped: string[];
    byReason: string;
  } {
    let mutations = 0;
    let required = 0;
    let storeNone = 0;
    let skipped = 0;
    const unscoped: string[] = [];
    const reasons = new Map<string, number>();

    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: unknown[]) => unknown;
        if (typeof handler !== 'function') continue;
        if (this.reflector.get<string | string[]>(PATH_METADATA, handler) === undefined) continue;
        if (!MUTATION_METHODS.has(this.reflector.get<RequestMethod>(METHOD_METADATA, handler))) continue;
        mutations += 1;

        const skip = this.reflector.getAllAndOverride<string>(SKIP_IDEMPOTENCY_KEY, [handler, metatype]);
        if (skip !== undefined) {
          skipped += 1;
          reasons.set(skip, (reasons.get(skip) ?? 0) + 1);
          continue;
        }
        const options = this.reflector.getAllAndOverride<IdempotentOptions>(IDEMPOTENT_KEY, [handler, metatype]);
        if (options?.required) required += 1;
        if (options?.store === 'none') storeNone += 1;

        // Публичная ручка без резолвера принципала: скоуп собрать не из чего —
        // ключ туда слать бессмысленно, и движок такой запрос пропускает
        const isPublic =
          this.reflector.get<boolean>(IS_PUBLIC_KEY, handler) || this.reflector.get<boolean>(IS_PUBLIC_KEY, metatype);
        if (isPublic && typeof options?.principal !== 'function') unscoped.push(`${metatype.name}.${method}`);
      }
    }
    const byReason = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}: ${n}`)
      .join(', ');
    return { mutations, covered: mutations - skipped - unscoped.length, required, storeNone, skipped, unscoped, byReason };
  }

  /** Список проблем; пустой — всё решено явно. */
  problems(): string[] {
    const out: string[] = [];
    if (!this.responseParamtypeHolds()) {
      out.push(`@Res() is no longer stored under route paramtype ${RESPONSE_PARAMTYPE}: fix RESPONSE_PARAMTYPE in idempotency.routes.audit.ts, otherwise handlers that write the response themselves go unnoticed`);
    }
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: unknown[]) => unknown;
        if (typeof handler !== 'function') continue;
        if (this.reflector.get<string | string[]>(PATH_METADATA, handler) === undefined) continue; // не маршрут
        const verb = this.reflector.get<RequestMethod>(METHOD_METADATA, handler);
        if (!MUTATION_METHODS.has(verb)) continue;

        const where = `${metatype.name}.${method}`;
        const skip = this.reflector.getAllAndOverride<string>(SKIP_IDEMPOTENCY_KEY, [handler, metatype]);
        if (skip !== undefined && !IDEMPOTENCY_SKIP_REASON_VALUES.includes(skip)) {
          out.push(`${where} → @SkipIdempotency('${skip}'): unknown reason (allowed: ${IDEMPOTENCY_SKIP_REASON_VALUES.join(', ')})`);
          continue;
        }
        if (skip !== undefined) continue;

        if (this.ownsResponse(metatype, method)) {
          out.push(`${where} → the handler writes the response itself (@Res() without passthrough): declare @SkipIdempotency('${IDEMPOTENCY_SKIP_REASONS.rawResponse}')`);
        }

        const options = this.reflector.getAllAndOverride<IdempotentOptions>(IDEMPOTENT_KEY, [handler, metatype]);
        const isPublic =
          this.reflector.get<boolean>(IS_PUBLIC_KEY, handler) || this.reflector.get<boolean>(IS_PUBLIC_KEY, metatype);
        const hasPrincipal = typeof options?.principal === 'function';
        if (isPublic && !hasPrincipal) {
          out.push(
            options?.required
              ? `${where} → @Idempotent({ required: true }) on a @Public route needs a principal resolver: without it the key has no scope`
              : `${where} → a @Public mutation must decide: a principal resolver (+ gate) or @SkipIdempotency(reason). Without either the client's key silently protects nothing`,
          );
        }
        if (hasPrincipal) {
          if (!options?.gate) {
            out.push(`${where} → a principal resolver needs a replay gate (@Idempotent({ principal, gate })): the handler authorizes the guest itself, and a replay never calls the handler`);
          } else if (!this.replayRenderers.gate(options.gate)) {
            out.push(`${where} → replay gate '${options.gate}' is not registered (IdempotencyReplayRegistry.registerGate in the owner's onModuleInit)`);
          }
        }
      }
    }

    // Рендерер на несуществующий маршрут: сверяем с ЖИВЫМ роутером — это ровно те
    // строки, которые интерцептор увидит в `req.route.path`
    const live = this.liveRoutes();
    if (live) {
      for (const key of this.replayRenderers.rendererKeys()) {
        if (!live.has(key)) out.push(`replay renderer '${key}' → no such route: the key must be METHOD + the route template exactly as Express registers it`);
      }
    }
    return out;
  }

  /** Живые маршруты Express (`POST /api/tasks/:id`); `null` — адаптер не Express 4. */
  private liveRoutes(): Set<string> | null {
    const app = this.adapterHost.httpAdapter?.getInstance?.() as
      | { _router?: { stack?: RouterLayer[] }; router?: { stack?: RouterLayer[] } }
      | undefined;
    const stack = app?._router?.stack ?? app?.router?.stack;
    if (!Array.isArray(stack)) return null;
    const out = new Set<string>();
    for (const layer of stack) {
      const path = layer.route?.path;
      if (typeof path !== 'string') continue;
      for (const [method, on] of Object.entries(layer.route?.methods ?? {})) {
        if (on) out.add(replayRouteKey(method, path));
      }
    }
    return out.size ? out : null;
  }

  /** `@Res()` всё ещё пишется под `RESPONSE_PARAMTYPE`? (проба на живом декораторе) */
  private responseParamtypeHolds(): boolean {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ResProbe, 'handler') as Record<string, unknown> | undefined;
    return !!args && Object.keys(args).some((k) => k === `${RESPONSE_PARAMTYPE}:0`);
  }

  /** Ручка сама пишет ответ (`@Res()` без `{ passthrough: true }`). */
  private ownsResponse(metatype: Function, method: string): boolean {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, method) as
      | Record<string, { index: number; data?: unknown }>
      | undefined;
    if (!args) return false;
    // Nest кладёт `{ passthrough: true }` НЕ в аргументы маршрута, а отдельной метаданной метода
    // (`RESPONSE_PASSTHROUGH_METADATA` на классе и имени метода) — читать её, иначе любая
    // ручка с `@Res({ passthrough: true })` ложно считалась бы «пишущей ответ сама»
    const passthrough = Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, metatype, method) === true;
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith(`${RESPONSE_PARAMTYPE}:`)) continue;
      const legacy = (value?.data as { passthrough?: boolean } | undefined)?.passthrough === true;
      if (!passthrough && !legacy) return true;
    }
    return false;
  }
}
