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

  // ---- Documents (core/docs): ЯВНЫЙ шеринг документа людям и Группам. Наследование от
  //      МЕСТА (задача/чат) сюда НЕ проецируется — его считает resolveMode() через
  //      FilesRefRegistry, потому что «правка» наследуется только от той привязки, через
  //      которую человек пришёл, а объединение по всем привязкам остаётся для просмотра.
  //      Отдельной таблицы грантов у движка нет — это ровно то, для чего есть core/access
  //      (гранты на Группу заработали бесплатно). ----
  document: {
    relations: {
      owner: THIS,
      editor: union(THIS, computed('owner')),
      viewer: union(THIS, computed('editor')),
    },
  },

  // ---- Шаблоны документов: КОМУ ДОСТУПЕН бланк для подачи ----
  // Одно отношение и никакой иерархии: «может подать по этому шаблону». Получателем
  // бывает человек, Группа, отдел, должность или филиал — движок раздаёт их одинаково,
  // поэтому «дать отделу продаж заявление на отпуск» не стоит ни строчки своего кода.
  doc_template: {
    relations: {
      requester: THIS,
    },
  },

  // ---- OmniDrive («Диск») ----
  // Пространство: хозяин один, «управляющие» — задел под будущего со-администратора
  // диска организации. Наследования по дереву тут нет: узлы наследуют право сами.
  drive_space: {
    relations: {
      owner: THIS,
      manager: union(THIS, computed('owner')),
    },
  },
  // Узел (папка/файл). В движке живут ТОЛЬКО ПРЯМЫЕ гранты; наследование по дереву
  // Диск считает сам — материализованным массивом предков и одним условием в SQL.
  //
  // Почему не `arrow('parent', …)`, как у витрины с магазином: у витрины ровно один
  // уровень родителя, а у папки их до 32. Рекурсивная схема означала бы обход предков
  // запрос за запросом на КАЖДУЮ проверку (замерено на прототипе: 22–55 запросов на
  // промах кэша), молчаливый обрыв на MAX_DEPTH и сброс кэша прав всей платформы
  // тип-эпохой при каждом шеринге. Прецеденты «движок хранит, домен считает массово»
  // уже есть: дерево отделов (closure пишет проекция) и поиск сообщений (права режутся
  // JOIN'ом в SQL).
  drive_node: {
    relations: {
      manager: THIS,
      editor: union(THIS, computed('manager')),
      viewer: union(THIS, computed('editor')),
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
  // ---- Оси оргструктуры (проецирует modules/staff, applyStaffDiff) ----
  // Отдел. `member` пишется ЗАМЫКАНИЕМ ВВЕРХ (сотрудник — член своего отдела и всех
  // предков: грант отделу достаёт подотделы при `member: THIS`). `head` — держатели
  // руководящей должности отдела, пишутся ЗАМЫКАНИЕМ ВНИЗ (голова отдела — голова и
  // всех его подотделов). Правило канона: лестница ROLE_LADDERS ОБЯЗАНА совпадать с
  // union-цепочкой типа — поэтому `member: union(THIS, computed('head'))`, а не THIS
  // (иначе check() и grantSetFor отвечали бы по-разному: голова — член отдела в обоих
  // читающих путях). `manager` — точка расширения под явное делегирование обычным
  // ребром; в лестницу НЕ входит (делегат — не участник отдела).
  department: {
    relations: {
      member: union(THIS, computed('head')),
      head: THIS,
      manager: union(THIS, computed('head')),
    },
  },
  position: {
    relations: { holder: THIS },
  },
  // Объект (StaffBranch; в UI пока «Филиал»). `head` — держатели руководящей должности
  // объекта, работающие В ЭТОМ объекте (управляющий чужой точки — не голова этой).
  branch: {
    relations: {
      member: union(THIS, computed('head')),
      head: THIS,
    },
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
 * Unmapped types (any NEW type not listed below) fall back to the GLOBAL epoch —
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
  // Без этой строки ЛЮБОЙ грант документа бил бы ГЛОБАЛЬНУЮ эпоху и сбрасывал ACL-кэш
  // всей платформы (фолбэк неизвестных типов — безопасный, но дорогой).
  document: ['document'],
  calendar: ['calendar'],
  card: ['card'],
  platform: ['platform'],
  workspace: ['workspace', 'shop', 'showcase'],
  // 'document' — гранты документа Группе живые: вышел из Группы ⇒ доступ к документу
  // обязан пропасть на следующем check(), а не дожить в кэше.
  circle: ['circle', 'showcase', 'wishlist', 'calendar', 'card', 'finbook', 'document'],
  // Staff-оси («Сотрудники»): membership-рёбра могут нести гранты на карточки
  // (card.full_viewer), витрины B2B и календарь — будущие аудитории Ленты/отпусков.
  // Отношения `head`/`manager` оргструктуры новых строк НЕ требуют: фанаут считается
  // по ТИПУ ресурса, а не по отношению — опасно только отсутствие ключа типа.
  department: ['department', 'card', 'showcase', 'calendar'],
  position: ['position', 'card', 'showcase', 'calendar'],
  branch: ['branch', 'card', 'showcase', 'calendar'],
  // ---- Диск: ПУСТОЙ фанаут, и это не забывчивость ----
  // Диск не пользуется кэшируемым check() движка вообще: его выборки идут через
  // grantSetFor + собственный предикат в SQL, который всегда читает живые tuples.
  // Инвалидировать нечего, поэтому шеринг папки не должен трогать ни одну эпоху.
  // Строки обязаны существовать: НЕзамапленный тип бьёт ГЛОБАЛЬНУЮ эпоху, то есть
  // каждый шеринг на Диске сбрасывал бы ACL-кэш всей платформы.
  //
  // ⚠️ Если у типов Диска когда-нибудь появится потребитель через check()/can() —
  // сначала заполнить эти массивы, иначе он будет видеть протухшие права до 10 минут.
  drive_space: [],
  drive_node: [],
  // Шаблоны документов — по той же причине, что и Диск: доступность читается пачкой
  // (grantSetFor), а не кэшируемым check(). Появится потребитель через check() —
  // сначала заполнить массив.
  doc_template: [],
};

/**
 * Лестницы фиксированных ролей: от самой сильной к самой слабой.
 *
 * Нужны массовому пути чтения (grantSetFor), который не проходит через резолвер и
 * поэтому не получает `computedUserset` из ACCESS_SCHEMA даром. Грант «всей команде»
 * пишется как `@workspace:<ws>#member`, и без разворота лестницы владелец организации,
 * у которого спроецирована роль `owner`, не совпал бы с этим грантом — то есть админ
 * не видел бы папку, открытую рядовым сотрудникам.
 *
 * Порядок обязан совпадать с union-цепочкой соответствующего типа в ACCESS_SCHEMA.
 */
export const ROLE_LADDERS: Record<string, readonly string[]> = {
  workspace: ['owner', 'admin', 'manager', 'member'],
  // Оси оргструктуры: голова отдела/объекта — его участник (грант «отделу продаж»
  // достаёт и его руководителя, даже если тот сидит вне отдела). Каждый грант
  // отделу/объекту разворачивается этой лестницей — правило действует на ВСЕХ
  // потребителях grantSetFor/principalsOf разом (шаблоны, Диск, адресаты).
  department: ['head', 'member'],
  branch: ['head', 'member'],
};

/**
 * Как ПРИНЦИПАЛ записывается в субъект tuple'а: человек — прямой субъект (`''`),
 * группирующая сущность — userset по своему отношению-членству.
 *
 * Карта одна на платформу, потому что ошибка здесь не видна ничем: грант успешно
 * записывается, показывается в списке — и не находит никого. Ровно так молча не
 * работала выдача шаблонов документов отделу, должности и филиалу: субъект писался
 * без отношения, а `principalsOf` отдаёт принципалы С отношением (`#member`,
 * `#holder`), и совпадения не возникало никогда.
 */
export function principalSubjectRelation(principalType: string): string {
  switch (principalType) {
    case 'user':
      return '';
    case 'position':
      return 'holder';
    default:
      // circle / workspace / department / branch — членство
      return 'member';
  }
}

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
