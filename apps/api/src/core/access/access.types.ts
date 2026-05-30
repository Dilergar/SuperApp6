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
