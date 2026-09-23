import { Injectable, Logger } from '@nestjs/common';

/**
 * Хук сервиса в каскаде окончательного удаления организации.
 *
 * Контракт: идемпотентен (прерванный каскад повторит следующий прогон ретеншна),
 * права не проверяет (решение принял ретеншн архива), на сбое БРОСАЕТ — каскад
 * прерывается целиком, строка организации остаётся, и ретеншн доберёт её снова.
 * Работает и для организации, строки которой уже нет (уборка хвостов прошлых удалений).
 */
export interface WorkspacePurgeHook {
  purge(workspaceId: string): Promise<void>;
}

/**
 * Данные организации, которыми владеет СЕРВИС, а не схема: строки с полиморфным
 * владельцем (`ownerType = workspace` — Диск, Заметки) внешним ключом на организацию
 * не связаны и пережили бы её удаление навсегда. Сервис регистрирует здесь, как стереть
 * их СВОИМ путём (гранты, индекс поиска, ссылки наружу, файлы), — `purgeWorkspace` зовёт
 * хуки до удаления строки организации. Движки платформы (core/*) сюда не встают: модуль
 * организаций зовёт их напрямую (направление «модуль → движок»).
 */
@Injectable()
export class WorkspacePurgeRegistry {
  private readonly logger = new Logger(WorkspacePurgeRegistry.name);
  private readonly hooks = new Map<string, WorkspacePurgeHook>();

  register(key: string, hook: WorkspacePurgeHook): void {
    if (this.hooks.has(key)) this.logger.warn(`Workspace purge hook "${key}" is already registered — overwriting`);
    this.hooks.set(key, hook);
  }

  entries(): Array<[string, WorkspacePurgeHook]> {
    return [...this.hooks.entries()];
  }
}
