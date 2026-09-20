import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { IDEMPOTENCY_SKIP_REASON_VALUES, IDEMPOTENCY_SKIP_REASONS } from '@superapp/shared';
import { IS_PUBLIC_KEY } from '../../shared/decorators/public.decorator';
import { IDEMPOTENT_KEY, SKIP_IDEMPOTENCY_KEY, type IdempotentOptions } from '../../shared/decorators/idempotency.decorator';
import { IdempotencyReplayRegistry } from './idempotency.replay.registry';

/**
 * `RouteParamtypes.RESPONSE` из Nest. Enum лежит во внутреннем пути пакета, поэтому
 * значение зафиксировано здесь с проверкой на буте: ключ метаданных аргументов — это
 * строка `"<тип>:<индекс>"`.
 */
const RESPONSE_PARAMTYPE = 1;

const MUTATION_METHODS = new Set<RequestMethod>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

/**
 * Страж движка идемпотентности на буте (fail-closed, как страж скоупов ключей).
 * Падает, если автор ручки оставил движок в невозможном состоянии:
 *
 *  1. Мутация отдаёт ответ сама (`@Res()` без passthrough) — снимать нечего, значит
 *     ручка обязана нести `@SkipIdempotency('raw_response')`, а не молча ломать реплей;
 *  2. `required: true` на `@Public`-ручке без `principal`-резолвера — скоуп собрать
 *     не из чего, и «обязательный ключ» ничего не защищал бы;
 *  3. причина `@SkipIdempotency` вне закрытого списка — исключение без смысла.
 */
@Injectable()
export class IdempotencyRoutesAudit implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyRoutesAudit.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly replayRenderers: IdempotencyReplayRegistry,
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
        `; ${this.replayRenderers.size} replay renderer(s)`,
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
        if (options?.required) {
          const isPublic =
            this.reflector.get<boolean>(IS_PUBLIC_KEY, handler) || this.reflector.get<boolean>(IS_PUBLIC_KEY, metatype);
          if (isPublic && typeof options.principal !== 'function') {
            out.push(`${where} → @Idempotent({ required: true }) on a @Public route needs a principal resolver: without it the key has no scope`);
          }
        }
      }
    }
    return out;
  }

  /** Ручка сама пишет ответ (`@Res()` без `{ passthrough: true }`). */
  private ownsResponse(metatype: Function, method: string): boolean {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, method) as
      | Record<string, { index: number; data?: unknown }>
      | undefined;
    if (!args) return false;
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith(`${RESPONSE_PARAMTYPE}:`)) continue;
      const passthrough = (value?.data as { passthrough?: boolean } | undefined)?.passthrough === true;
      if (!passthrough) return true;
    }
    return false;
  }
}
