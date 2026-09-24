import { Injectable, Logger } from '@nestjs/common';
import type { VisibilityRecordType } from '@superapp/shared';

// ============================================================
// core/visibility — реестры, которыми фичи подключаются к движку (движок фичи не импортирует)
// ============================================================

/** Кто смотрит на запись при раскрытии/объяснении (движок решает право на ПОЛЯ, провайдер — на ЗАПИСЬ). */
export interface VisibilityRecordRef {
  recordId: string;
  /** Субъект записи (человек) — для «сам» и руководителя; нет — null */
  subjectId: string | null;
  /** Организация записи — владелец политики */
  workspaceId: string | null;
  /** Этап записи (правило может быть ограничено этапом) */
  stage?: string | null;
  /** Объект (площадка) записи — для руководителя объекта и гранта «видит деньги» */
  branchId?: string | null;
}

/**
 * Провайдер типа записи (обязателен для КАЖДОГО типа реестра shared — иначе бут падает,
 * как у `KeysRoutesAudit`). Регистрирует сервис-владелец данных.
 */
export interface VisibilityTypeProvider {
  /**
   * Прочитать ОДНУ запись для раскрытия / «Проверить сотрудника»: провайдер ОБЯЗАН сам
   * проверить право зрителя на ЗАПИСЬ (гейт сервиса) и вернуть `null`, если записи нет или
   * она не видна — движок отвечает одинаковым 404 (не оракул существования).
   * `values` — сырые значения запрошенных полей (ключи реестра).
   */
  loadForReveal(viewerId: string, workspaceId: string | null, recordId: string, fields: readonly string[]): Promise<{ ref: VisibilityRecordRef; values: Record<string, unknown> } | null>;
}

@Injectable()
export class VisibilityTypeRegistry {
  private readonly logger = new Logger(VisibilityTypeRegistry.name);
  private readonly providers = new Map<string, VisibilityTypeProvider>();

  register(type: VisibilityRecordType, provider: VisibilityTypeProvider): void {
    if (this.providers.has(type)) this.logger.warn(`Visibility type provider "${type}" is already registered — overwriting`);
    this.providers.set(type, provider);
  }

  get(type: string): VisibilityTypeProvider | undefined {
    return this.providers.get(type);
  }

  registeredTypes(): string[] {
    return [...this.providers.keys()];
  }
}

/**
 * Относительные адресаты: «кем зритель руководит» и «какими объектами». Регистрирует
 * `StaffModule` (оргструктура и объекты — его данные); движок спрашивает ОДИН раз на запрос.
 * Прав не проверяет — отвечает о фактах.
 */
export interface VisibilityRelationProvider {
  /** Подчинённые зрителя по вертикали (инверсия `managerOf`) */
  subordinateIdsOf(workspaceId: string, viewerId: string): Promise<string[]>;
  /** Объекты (с потомками), которыми зритель руководит: голова или управляющий объекта */
  headedBranchIdsOf(workspaceId: string, viewerId: string): Promise<string[]>;
  /** Объекты (с потомками), где у зрителя пообъектный грант «видит деньги» (`branch#payroll_viewer`) */
  payrollBranchIdsOf(workspaceId: string, viewerId: string): Promise<string[]>;
  /** Объекты (с потомками), где зритель ведёт график: голова, управляющий или делегат `branch#scheduler` */
  schedulerBranchIdsOf(workspaceId: string, viewerId: string): Promise<string[]>;
  /** Объекты, где люди работают СЕЙЧАС (действующие назначения) — для «руководитель объекта субъекта» */
  branchIdsOfUsers(workspaceId: string, userIds: readonly string[]): Promise<Map<string, string[]>>;
}

@Injectable()
export class VisibilityRelationRegistry {
  private provider: VisibilityRelationProvider | null = null;

  register(provider: VisibilityRelationProvider): void {
    this.provider = provider;
  }

  get(): VisibilityRelationProvider | null {
    return this.provider;
  }
}

/** Связь зрителя с субъектом в личном графе. */
export interface VisibilityPersonalGraphRelation {
  linked: boolean;
  /** Группы СУБЪЕКТА, в которых зритель (для правил субъекта) */
  subjectCircleIds: string[];
  /** Группы ЗРИТЕЛЯ, в которых субъект (взаимность присутствия: что зритель сам показывает субъекту) */
  viewerCircleIds: string[];
  /** Организации, где оба — в команде */
  sharedWorkspaceIds: string[];
}

/**
 * Личный граф (Окружение) глазами движка: связь, Группы субъекта со зрителем, общие
 * организации. Регистрирует `ContactsModule`: движок не читает таблицы графа сам
 * («сначала переиспользуй» — `resolveCircleMemberIds`/`listCircleIdsWhereMember`).
 */
export interface VisibilityPersonalGraphProvider {
  /**
   * Для зрителя и набора субъектов: связаны ли, в каких Группах СУБЪЕКТА зритель, в каких
   * организациях оба в команде. Один пакетный вызов на ответ.
   */
  relationsOf(viewerId: string, subjectIds: readonly string[]): Promise<Map<string, VisibilityPersonalGraphRelation>>;
  /** Живые Группы человека (для редактора и снятия правил удалённой Группы) */
  circleIdsOwnedBy(ownerId: string): Promise<string[]>;
}

@Injectable()
export class VisibilityPersonalGraphRegistry {
  private provider: VisibilityPersonalGraphProvider | null = null;

  register(provider: VisibilityPersonalGraphProvider): void {
    this.provider = provider;
  }

  get(): VisibilityPersonalGraphProvider | null {
    return this.provider;
  }
}
