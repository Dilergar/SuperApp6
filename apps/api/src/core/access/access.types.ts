// Core value types for the access engine (core/access). Kept backend-only for now;
// web/mobile types arrive when endpoints are added (Phase 2+).

/** A concrete actor an access decision is run FOR (always a real subject, never a userset). */
export interface Principal {
  type: string; // normally 'user'
  id: string;
}

/** A resource an access decision concerns. */
export interface ResourceRef {
  type: string; // 'showcase' | 'calendar' | 'card' | 'task' | 'shop' | 'workspace' | ...
  id: string;
}

/** The subject side of a stored tuple, as the resolver reads it. */
export interface SubjectRef {
  subjectType: string;
  subjectId: string;
  subjectRelation: string; // '' = direct subject; otherwise a userset relation (e.g. 'member')
}

/** Input to write a relationship edge. subjectRelation defaults to '' (direct). */
export interface RelationTupleInput {
  resourceType: string;
  resourceId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string;
}

/** The wildcard subject that grants to everyone. */
export const PUBLIC_SUBJECT_TYPE = 'public';
export const PUBLIC_SUBJECT_ID = '*';

/**
 * Результат массового чтения грантов (`AccessService.grantSetFor`) — второй читающий
 * путь движка, рядом с поштучным `check()`.
 *
 * Нужен сервисам, которые фильтруют СПИСКИ под правами: спрашивать движок по строке
 * означало бы N проверок на страницу, а `listObjects` обходит граф с потолком в 10 000
 * посещённых узлов и молча обрезает выдачу. Здесь домен получает сырой материал —
 * «кто я такой» и «что мне выдано» — и подставляет его одним условием в свой SQL.
 *
 * Канонично для семейства Zanzibar: рядом с поштучным Check у всех есть массовый путь
 * (ListObjects у OpenFGA, LookupResources у SpiceDB, Leopard у Google).
 */
export interface GrantSet {
  /** Все принципалы зрителя: он сам + Группы + роли организаций + оси оргструктуры */
  principals: SubjectRef[];
  /** relation → id ресурсов, на которые этот relation выдан хотя бы одному принципалу */
  granted: Map<string, string[]>;
}
