import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { keyScopeServiceOf } from '@superapp/shared';
import { KEY_SCOPE_KEY, NO_API_KEYS_KEY } from '../../../shared/decorators/api-keys.decorator';
import { IS_PUBLIC_KEY } from '../../../shared/decorators/public.decorator';

/** uuid-заглушка вместо `:param` — так же, как `keyPrefixMatches` видит живой путь */
const UUID_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

/**
 * Страж реестра скоупов на буте (fail-closed, как страж маршрутов кабинета платформы):
 * каждый маршрут организации `/workspaces/…` обязан быть РЕШЁН — либо покрыт строкой
 * `KEY_SCOPE_SERVICES` (открыт ключам с этим скоупом), либо помечен `@NoApiKeys()`
 * (только живая сессия человека), либо `@Public()`. Иначе бут падает со списком:
 * новый контроллер под `/workspaces/:id/…` нельзя ни открыть ботам молча (catch-all
 * запрещён), ни оставить «как получится» — автор принимает решение явно, в коде.
 */
@Injectable()
export class KeysRoutesAudit implements OnApplicationBootstrap {
  private readonly logger = new Logger(KeysRoutesAudit.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const problems = this.undecidedWorkspaceRoutes();
    if (problems.length) {
      const msg = `workspace routes are not decided for API keys (KEY_SCOPE_SERVICES row or @NoApiKeys() required):\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  /** Маршруты `/workspaces/…`, которые не покрывает реестр и не закрывает декоратор. */
  undecidedWorkspaceRoutes(): string[] {
    const out: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const controllerPaths = this.paths(this.reflector.get<string | string[]>(PATH_METADATA, metatype));
      if (!controllerPaths.some((p) => /^\/?workspaces(\/|$)/.test(p))) continue;
      if (this.reflector.get<boolean>(NO_API_KEYS_KEY, metatype) || this.reflector.get<boolean>(IS_PUBLIC_KEY, metatype)) continue;
      if (this.reflector.get<string>(KEY_SCOPE_KEY, metatype)) continue;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: unknown[]) => unknown;
        if (typeof handler !== 'function') continue;
        const raw = this.reflector.get<string | string[]>(PATH_METADATA, handler);
        if (raw === undefined) continue; // не маршрут
        if (this.reflector.get<boolean>(NO_API_KEYS_KEY, handler) || this.reflector.get<boolean>(IS_PUBLIC_KEY, handler)) continue;
        if (this.reflector.get<string>(KEY_SCOPE_KEY, handler)) continue;
        for (const base of controllerPaths) {
          for (const sub of this.paths(raw)) {
            const full = `/${[base, sub].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
            const probe = full.replace(/:[A-Za-z0-9_]+/g, UUID_PLACEHOLDER);
            if (keyScopeServiceOf(probe)) continue;
            out.push(`${metatype.name}.${method} → ${full}`);
          }
        }
      }
    }
    return out;
  }

  private paths(raw: string | string[] | undefined): string[] {
    if (raw === undefined) return [''];
    return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }
}
