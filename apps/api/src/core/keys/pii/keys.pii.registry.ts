import { normalizePhone } from '@superapp/shared';
import type { PiiModelDef, PiiScopeRef } from '../../../shared/database/pii-hooks';

// ============================================================
// Реестр ПДн-полей (решение грилла №10): что шифруется, чем индексируется, под чьим KEK.
// Открытыми остаются имена/фамилии (поиск и сортировка — вопрос юристу), БИН, адреса площадок.
// ============================================================

const digits = (v: string) => v.replace(/\D/g, '');
const lower = (v: string) => v.trim().toLowerCase();
const phoneNorm = (v: string) => (v.startsWith('deleted:') || v.startsWith('bot:') ? v : normalizePhone(v));

const platform: PiiScopeRef = { type: 'platform' };
const workspaceOf = (row: Record<string, unknown>): PiiScopeRef | null =>
  typeof row.workspaceId === 'string' ? { type: 'workspace', id: row.workspaceId } : null;

export const PII_MODELS: PiiModelDef[] = [
  {
    model: 'User',
    entity: 'user',
    scopeFields: ['id'],
    scope: (row) => (typeof row.id === 'string' ? { type: 'user', id: row.id } : null),
    fields: [
      { name: 'phone', enc: 'phoneEnc', bi: 'phoneBi', index: 'phone', normalize: phoneNorm },
      { name: 'email', enc: 'emailEnc', bi: 'emailBi', index: 'email', normalize: lower },
      { name: 'iin', enc: 'iinEnc', bi: 'iinBi', index: 'iin', normalize: digits, sensitive: true },
      { name: 'dateOfBirth', enc: 'dateOfBirthEnc', kind: 'date', sensitive: true },
      { name: 'residentialAddress', enc: 'residentialAddressEnc', sensitive: true },
      { name: 'idDocNumber', enc: 'idDocNumberEnc', sensitive: true },
      { name: 'idDocIssuedBy', enc: 'idDocIssuedByEnc', sensitive: true },
    ],
  },
  {
    model: 'ContactInvitation',
    entity: 'contact_invitation',
    scopeFields: ['fromUserId'],
    scope: (row) => (typeof row.fromUserId === 'string' ? { type: 'user', id: row.fromUserId } : null),
    fields: [{ name: 'toPhone', enc: 'toPhoneEnc', bi: 'toPhoneBi', index: 'phone', normalize: phoneNorm }],
  },
  {
    model: 'WorkspaceInvitation',
    entity: 'workspace_invitation',
    scopeFields: ['workspaceId'],
    scope: workspaceOf,
    fields: [{ name: 'toPhone', enc: 'toPhoneEnc', bi: 'toPhoneBi', index: 'phone', normalize: phoneNorm }],
  },
  {
    model: 'VerifyChallenge',
    entity: 'verify_challenge',
    scopeFields: [],
    scope: () => platform,
    fields: [{ name: 'phone', enc: 'phoneEnc', bi: 'phoneBi', index: 'phone', normalize: phoneNorm }],
  },
  {
    model: 'ShareLinkGuest',
    entity: 'share_link_guest',
    scopeFields: ['ownerType', 'ownerId'],
    scope: (row) =>
      row.ownerType === 'workspace' && typeof row.ownerId === 'string'
        ? { type: 'workspace', id: row.ownerId }
        : row.ownerType === 'user' && typeof row.ownerId === 'string'
          ? { type: 'user', id: row.ownerId }
          : null,
    fields: [{ name: 'phone', enc: 'phoneEnc', bi: 'phoneBi', index: 'phone', normalize: phoneNorm }],
    compoundUniques: { ownerType_ownerId_phone: { bi: 'ownerType_ownerId_phoneBi', field: 'phone' } },
  },
  {
    model: 'WorkspaceBankAccount',
    entity: 'workspace_bank_account',
    scopeFields: ['workspaceId'],
    scope: workspaceOf,
    fields: [{ name: 'iban', enc: 'ibanEnc', sensitive: true }],
  },
  {
    model: 'CounterpartyBankAccount',
    entity: 'counterparty_bank_account',
    scopeFields: ['workspaceId'],
    scope: workspaceOf,
    fields: [{ name: 'iban', enc: 'ibanEnc', sensitive: true }],
  },
  {
    model: 'Counterparty',
    entity: 'counterparty',
    scopeFields: ['workspaceId'],
    scope: workspaceOf,
    fields: [
      { name: 'phone', enc: 'phoneEnc', bi: 'phoneBi', index: 'phone', normalize: phoneNorm },
      { name: 'email', enc: 'emailEnc' },
    ],
  },
  {
    model: 'CounterpartyContact',
    entity: 'counterparty_contact',
    scopeFields: ['workspaceId'],
    scope: workspaceOf,
    fields: [
      { name: 'phone', enc: 'phoneEnc', bi: 'phoneBi', index: 'phone', normalize: phoneNorm },
      { name: 'email', enc: 'emailEnc' },
    ],
  },
  {
    model: 'SignAct',
    entity: 'sign_act',
    scopeFields: [],
    scope: () => platform,
    fields: [{ name: 'certSubjectIin', enc: 'certSubjectIinEnc', bi: 'certSubjectIinBi', index: 'iin', normalize: digits, sensitive: true }],
  },
];

export const PII_MODEL_MAP: ReadonlyMap<string, PiiModelDef> = new Map(PII_MODELS.map((m) => [m.model, m]));

/**
 * Открытые колонки ПДн ещё в схеме (окно dual-write). Переключается на `false` тем же
 * деплоем, что и миграция дропа открытых колонок (шаг 5 плана, docs/keys_pii.md): после
 * него фильтры по ПДн — строго по слепому индексу, а результат — только из `_enc`.
 */
export const PII_PLAINTEXT_PRESENT = true;
