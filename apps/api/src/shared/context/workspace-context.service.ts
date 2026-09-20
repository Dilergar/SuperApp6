import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_LOCALE, type Locale } from '@superapp/i18n';
import type { IdemBinding } from '../idempotency/binding';

export interface WorkspaceContext {
  userId?: string;
  /** Active workspace for this request (from X-Workspace-Id), set ONLY after a membership check. */
  activeWorkspaceId?: string;
  /** The user's effective role in the active workspace. */
  role?: string;
  /**
   * Язык ЭТОГО запроса (`Accept-Language` клиента). Ставится интерцептором без
   * единого обращения к БД: клиент (веб/mobile/AI) шлёт свой текущий язык сам,
   * гость — язык браузера. `User.locale` нужен только ФОНУ (push/SMS), где
   * запроса нет вовсе.
   */
  locale?: Locale;
  /**
   * Организация из заголовка БЕЗ проверки членства — только на маршрутах
   * `@DeferWorkspaceCheck()` (приём аналитики). Никогда не читается как право.
   */
  claimedWorkspaceId?: string;
  /** Клиентский контекст для серверных событий аналитики (core/analytics). */
  client?: AnalyticsClientContext;
  /**
   * Заявка движка идемпотентности (core/idempotency): что писать в отметку «эффект
   * закоммичен» и что уже случилось в этом запросе. Ставит интерцептор движка ПОСЛЕ
   * того, как заявка заведена; читает обёртка `$transaction` в фабрике клиента базы.
   * Нет заявки (запрос без ключа, джоб, крон) — обёртка строгий no-op.
   */
  idem?: IdemBinding;
}

/**
 * Контекст клиента: сессия и устройство из заголовков `X-Analytics-Session/Device`
 * (uuid, иначе игнор), `sid` токена, User-Agent для грубых признаков устройства.
 * IP сюда не кладётся: аналитика его не хранит и не использует.
 */
export interface AnalyticsClientContext {
  sessionId?: string;
  deviceId?: string;
  loginSid?: string;
  userAgent?: string;
  /** Браузер прислал `Sec-GPC: 1` */
  gpc?: boolean;
}

/**
 * Request-scoped "active workspace" context, backed by AsyncLocalStorage (no extra deps).
 *
 * Populated by WorkspaceContextInterceptor from the `X-Workspace-Id` header AFTER verifying
 * membership. Read by the DatabaseService `$use` middleware to auto-scope workspace-owned
 * models to the active workspace — the "chokepoint" turnstile.
 *
 * When no active workspace is set (personal mode), the middleware is a strict no-op, so
 * personal/social flows are completely unaffected.
 */
@Injectable()
export class WorkspaceContextService {
  private readonly als = new AsyncLocalStorage<WorkspaceContext>();

  run<T>(context: WorkspaceContext, fn: () => T): T {
    return this.als.run(context, fn);
  }

  get(): WorkspaceContext | undefined {
    return this.als.getStore();
  }

  get activeWorkspaceId(): string | undefined {
    return this.als.getStore()?.activeWorkspaceId;
  }

  /** Язык запроса; вне запроса (бутстрап, крон без обёртки) — язык по умолчанию. */
  get locale(): Locale {
    return this.als.getStore()?.locale ?? DEFAULT_LOCALE;
  }
}
