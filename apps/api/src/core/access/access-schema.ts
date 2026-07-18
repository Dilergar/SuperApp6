// The authorization MODEL: per resource-type, how each relation is computed from
// stored tuples + rewrite rules. This is config (versioned in code) — adding a new
// resource type or relation is an edit here, NOT a database migration. Mirrors the
// Zanzibar / OpenFGA / SpiceDB rewrite primitives:
//   this            — directly stored tuples for this (resource, relation)
//   computedUserset — another relation on the SAME object implies this one (editor ⇒ viewer)
//   tupleToUserset  — follow a tupleset relation to a PARENT object, take its relation
//                     (showcase.manager inherits shop.manager via the 'parent' pointer)
//   union           — any child rule grants it (most-permissive-wins; we are grant-based)

export type RelationRule =
  | { kind: 'this' }
  | { kind: 'computedUserset'; relation: string }
  | { kind: 'tupleToUserset'; tupleset: string; computedUserset: string }
  | { kind: 'union'; children: RelationRule[] };

const THIS: RelationRule = { kind: 'this' };
const computed = (relation: string): RelationRule => ({ kind: 'computedUserset', relation });
const arrow = (tupleset: string, computedUserset: string): RelationRule => ({
  kind: 'tupleToUserset',
  tupleset,
  computedUserset,
});
const union = (...children: RelationRule[]): RelationRule => ({ kind: 'union', children });

export interface ResourceTypeConfig {
  relations: Record<string, RelationRule>;
  /** Ordered low → high. Enables resolveLevel() (e.g. calendar busy < detailed). */
  levels?: string[];
}

export const ACCESS_SCHEMA: Record<string, ResourceTypeConfig> = {
  // ---- My Wish & Shop ----
  shop: {
    relations: {
      owner: THIS,
      manager: union(THIS, computed('owner')),
    },
  },
  showcase: {
    relations: {
      parent: THIS, // showcase:42#parent@shop:7 (object subject) — drives inheritance
      manager: union(THIS, arrow('parent', 'manager')), // inherit the shop's managers
      viewer: union(THIS, computed('manager')),
    },
  },
  // ---- Wishlist (one per user; shared to people/Groups like a showcase, Phase 8) ----
  wishlist: {
    relations: {
      owner: THIS, // wishlist:<userId>#owner@user:<userId>
      viewer: union(THIS, computed('owner')), // owner always sees; others by grant (user / circle#member)
    },
  },

  // ---- Финансы: книга (whole-book sharing; owner is checked in code, not mirrored) ----
  // editor («ведёт вместе») ⇒ viewer («смотрит»). Grants go to users and Circle Groups
  // (live circle principal). Direct user grants are revoked by FinancesEvents when the
  // ContactLink dies (PRD: разрыв связи = потеря доступа); circle grants die with membership.
  finbook: {
    relations: {
      editor: THIS,
      viewer: union(THIS, computed('editor')),
    },
  },

  // ---- Calendar (levels: none < busy < detailed; 'none' = no tuple) ----
  calendar: {
    levels: ['busy_viewer', 'detailed_viewer'],
    relations: {
      owner: THIS,
      detailed_viewer: union(THIS, computed('owner')),
      busy_viewer: union(THIS, computed('detailed_viewer')),
    },
  },

  // ---- Person/employee card (field-level visibility is a thin layer ON TOP) ----
  // B2C: card access = ContactLink (connection) + per-Group field flags — NOT the engine.
  // B2B (Phase 4 foundation): an employee's card shows a minimal FLOOR (Имя+Должность) to all
  // colleagues (field-layer default in company context); `full_viewer` is GRANTED to specific org
  // audiences (department/branch/position/role) to upgrade them to the full card. Grant-based —
  // "not granted" = minimal only. The future «Сотрудники» service writes those grants.
  card: {
    relations: {
      owner: THIS,
      viewer: union(THIS, computed('owner')),
      full_viewer: union(THIS, computed('owner')),
    },
  },

  // ---- Tasks (visibility; obligation/executors stay snapshot in the Tasks domain) ----
  task: {
    relations: {
      creator: THIS,
      executor: THIS,
      co_executor: THIS,
      observer: THIS,
      viewer: union(THIS, computed('creator'), computed('executor'), computed('co_executor'), computed('observer')),
    },
  },

  // ---- Shop orders (Phase 3): a closed conversation around a purchase/campaign.
  //      Members = buyer + seller + crowdfunding contributors. Drives the order chat. ----
  order: {
    relations: {
      buyer: THIS,
      seller: THIS,
      contributor: THIS, // crowdfunding pledger
      viewer: union(THIS, computed('buyer'), computed('seller'), computed('contributor')),
    },
  },

  // ---- Calendar events (Phase 3): per-EVENT membership for the event chat. Distinct from
  //      `calendar` (per-USER-calendar visibility); this is one resource per event row. ----
  event: {
    relations: {
      organizer: THIS,
      attendee: THIS,
      viewer: union(THIS, computed('organizer'), computed('attendee')),
    },
  },

  // ---- Office rooms (Виртуальный офис, B2B): per-MEETING membership for the meeting chat
  //      and rich card. host = организатор; participant = приглашённый/вошедший. «Войти по
  //      ссылке» решает НЕ движок, а canJoin-резолвер офиса (роль воркспейса ≥ trainee). ----
  office_room: {
    relations: {
      host: THIS,
      participant: THIS,
      viewer: union(THIS, computed('host'), computed('participant')),
    },
  },

  // ---- Platform personas (system-level grants that unlock features; additive, gate nothing
  //      existing — used by future Marketplace / Jobs «Тайный гость» / UGC). Singleton resource id. ----
  platform: {
    relations: {
      seller: THIS,
      mystery_guest: THIS,
      ugc_blogger: THIS,
    },
  },

  // ---- Workspace fixed access roles (owner ⊇ admin ⊇ manager ⊇ member) ----
  workspace: {
    relations: {
      owner: THIS,
      admin: union(THIS, computed('owner')),
      manager: union(THIS, computed('admin')),
      member: union(THIS, computed('manager')),
    },
  },

  // ---- Group / principal objects (their members are usersets referenced by grants) ----
  circle: {
    relations: { member: THIS },
  },
  // ---- Messenger chats (DM now; group/context inherit membership via projection, Phase 2) ----
  chat: {
    // DM: both users get `member`. Group/context chats: members are synced from the parent
    // (task/circle/event…) via projection → uniform Hard Revoke for any parent type.
    relations: {
      member: THIS,
      viewer: union(THIS, computed('member')),
    },
  },
  department: {
    // Subdepartment roll-up is done by CLOSURE projection (Phase 4): each employee is
    // projected as member of their department AND all ancestor departments, so a grant
    // to a department naturally reaches subdepartment members with `member: THIS`.
    relations: { member: THIS },
  },
  position: {
    relations: { holder: THIS },
  },
  // Org-structure location (Филиал: city/address/requisites in the future Сотрудники service).
  branch: {
    relations: { member: THIS },
  },
};

// ============================================================
// Perf maps (arch-review block 3). Keep in sync with how projections WRITE tuples —
// a new userset/parent shape must be added here or listObjects will miss results
// and stale caches may outlive a grant.
// ============================================================

/**
 * Principal node types that are ALWAYS worth expanding on the listObjects reverse walk
 * (they can carry grants toward any resource type: users, Groups, org structure).
 */
export const GENERIC_PRINCIPALS: readonly string[] = ['user', 'circle', 'workspace', 'department', 'position', 'branch'];

/**
 * Extra node types worth expanding PER TARGET type (beyond GENERIC_PRINCIPALS):
 *  - chat membership is usersets over task/order/event roles → those nodes lead to chats;
 *  - showcase inherits managers from its parent shop → shop nodes lead to showcases.
 * Everything else (a task node while searching calendars, a chat node anywhere, …) is a
 * dead end and is pruned — this is what turns the BFS from "every tuple the user touches"
 * into "only the paths that can reach the target type".
 */
export const LIST_OBJECTS_EXTRA_EXPANSION: Record<string, string[]> = {
  chat: ['task', 'order', 'event', 'office_room'],
  showcase: ['shop'],
};

/**
 * Cache-epoch fan-out: mutating tuples OF <key type> must invalidate cached check()
 * results of <value types> (the types whose resolution can traverse the mutated tuples).
 * Unmapped types (department/position/branch/new ones) fall back to the GLOBAL epoch —
 * coarse but safe-by-default. This replaces the single global epoch the review flagged
 * (every task/chat write was flushing the WHOLE platform's ACL cache).
 */
export const EPOCH_FANOUT: Record<string, string[]> = {
  // 'chat' из фанаутов task/order/event/office_room/workspace УБРАН (перф-ревью
  // 2026-07-18): тип-эпоха chat сбрасывала кэш прав ВСЕХ чатов платформы на каждую
  // доменную мутацию (новая задача где угодно → hit-rate ≈ 0). Теперь chat живёт на
  // ПООБЪЕКТНОЙ эпохе (OBJECT_EPOCH_TYPES в access.service): прямые chat-tuples бампают
  // свой чат, а мутации родителей (CHAT_PARENT_SUBJECT_TYPES) бампают зависимые чаты
  // реверс-lookup'ом; фолбэк при сбое lookup'а — тип-эпоха chat (safe).
  task: ['task'],
  order: ['order'],
  event: ['event'],
  office_room: ['office_room'],
  // Ключ обязан существовать (иначе chat-запись уронит ГЛОБАЛЬНУЮ эпоху); сами бампы
  // чата — пообъектные, тип-эпоха остаётся только фолбэком.
  chat: ['chat'],
  shop: ['shop', 'showcase'],
  showcase: ['showcase'],
  wishlist: ['wishlist'],
  finbook: ['finbook'],
  calendar: ['calendar'],
  card: ['card'],
  platform: ['platform'],
  workspace: ['workspace', 'shop', 'showcase'],
  circle: ['circle', 'showcase', 'wishlist', 'calendar', 'card', 'finbook'],
  // Staff-оси («Сотрудники»): membership-рёбра могут нести гранты на карточки
  // (card.full_viewer), витрины B2B и календарь — будущие аудитории Ленты/отпусков.
  department: ['department', 'card', 'showcase', 'calendar'],
  position: ['position', 'card', 'showcase', 'calendar'],
  branch: ['branch', 'card', 'showcase', 'calendar'],
};

/**
 * Типы с ПООБЪЕКТНОЙ эпохой кэша (высокая кардинальность + частые мутации соседей):
 * check() читает третий компонент эпохи `acl:epoch:<type>:<id>`, бамп — точечный.
 */
export const OBJECT_EPOCH_TYPES: ReadonlySet<string> = new Set(['chat']);

/**
 * Типы-родители, чьи tuples входят в usersets чатов (chat#member@<type>#<role>):
 * мутация их tuples обязана бампать пообъектные эпохи ЗАВИСИМЫХ чатов (реверс-lookup
 * по subjectType/subjectId). Держать в синхроне с LIST_OBJECTS_EXTRA_EXPANSION.chat.
 */
export const CHAT_PARENT_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  'task',
  'order',
  'event',
  'office_room',
  'workspace',
]);
