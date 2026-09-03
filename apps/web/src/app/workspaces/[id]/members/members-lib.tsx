'use client';

// ============================================================
// Сервис «Сотрудники» — общее для пяти разделов (Люди · Орг. структура · Объекты ·
// Приглашения · Сроки): базовые запросы организации, каркас страницы, редирект
// легаси-адресов `?tab=`, мелкие компоненты справочников. Извлечено из прежней
// одностраничной версии БЕЗ изменения поведения — разделы стали маршрутами
// (второй уровень сайдбара).
// ============================================================

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import { workspaceKey, workspaceMembersKey, workspaceStaffKey, orgRootKey } from '@/lib/queries';
import { invalidateEntities } from '@/lib/entities';
import { Alert, Chip, Field, Icon, IconButton, PageHeader } from '@/components/ui';
import { WORKSPACE_ROLES, type StaffDirectory, type Workspace, type WorkspaceMember, type WorkspaceRole } from '@superapp/shared';

export const roleLabel = (r: string): string => WORKSPACE_ROLES[r as WorkspaceRole]?.name ?? r;

/** «Санжар Намыс» → ['Санжар', 'Намыс'] — PersonChip ждёт имя и фамилию раздельно. */
export const splitName = (full: string): [string, string | null] => {
  const parts = (full || '?').trim().split(/\s+/);
  return [parts[0] ?? '?', parts.slice(1).join(' ') || null];
};

/** Разделы сервиса — адреса (второй уровень сайдбара; легаси `?tab=` редиректит сюда). */
export const membersSectionHref = (workspaceId: string, section: 'people' | 'org' | 'branches' | 'invitations' | 'deadlines'): string => {
  const base = `/workspaces/${workspaceId}/members`;
  return section === 'people' ? base : `${base}/${section}`;
};

const LEGACY_TAB_TO_SECTION: Record<string, 'people' | 'org' | 'branches' | 'invitations' | 'deadlines'> = {
  people: 'people',
  positions: 'org',
  departments: 'org',
  branches: 'branches',
  invites: 'invitations',
  deadlines: 'deadlines',
};

/**
 * Легаси-адрес `?tab=…` (уведомления КЭДО и плитка Главной ведут на `?tab=deadlines`)
 * — клиентский `router.replace` на новый раздел. Редирект, не удаление: разосланные
 * уведомления живут долго.
 */
export function useLegacyMembersTabRedirect(workspaceId: string): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (!tab) return;
    const section = LEGACY_TAB_TO_SECTION[tab];
    if (!section) return;
    const target = membersSectionHref(workspaceId, section);
    if (pathname !== target) router.replace(target);
    else router.replace(pathname);
  }, [searchParams, pathname, router, workspaceId]);
}

/**
 * Базовые запросы сервиса: организация, ростер, справочники + инвалидация после мутаций.
 * Разделы берут ровно то, что рисуют: витрине схемы нужен только сам воркспейс, а она
 * тянула ещё ростер и справочники на каждый заход (`opts` выключает лишнее).
 */
export function useMembersBase(workspaceId: string, opts: { members?: boolean; staff?: boolean } = {}) {
  const wantMembers = opts.members !== false;
  const wantStaff = opts.staff !== false;
  const { isReady, user } = useRequireAuth();
  const qc = useQueryClient();

  const wsQ = useQuery({
    queryKey: workspaceKey(workspaceId),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${workspaceId}`),
    enabled: isReady,
  });
  const ws = wsQ.data;
  const myRole = ws?.myRole;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const canStaff = canManage || myRole === 'manager';

  const membersQ = useQuery({
    queryKey: workspaceMembersKey(workspaceId),
    queryFn: async () => await apiGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
    enabled: isReady && wantMembers,
  });
  const staffQ = useQuery({
    queryKey: workspaceStaffKey(workspaceId),
    queryFn: async () => await apiGet<StaffDirectory>(`/workspaces/${workspaceId}/staff`),
    enabled: isReady && wantStaff,
  });

  // Любая мутация справочников/назначений → точечная инвалидация + кэш EntitySelector
  // + снимок оргструктуры (канвас и «место в структуре» читают свой React Query).
  const refreshStaff = () => {
    qc.invalidateQueries({ queryKey: workspaceStaffKey(workspaceId) });
    qc.invalidateQueries({ queryKey: workspaceMembersKey(workspaceId) });
    qc.invalidateQueries({ queryKey: orgRootKey(workspaceId) });
    invalidateEntities('department');
    invalidateEntities('position');
    invalidateEntities('branch');
    // «Люди» в контексте организации = ростер: найм/увольнение/должности меняют и его.
    invalidateEntities('user');
  };

  const dir: StaffDirectory = staffQ.data ?? { departments: [], positions: [], branches: [] };
  const members = membersQ.data ?? [];

  return { isReady, user, ws, wsQ, myRole, canManage, canStaff, membersQ, staffQ, dir, members, refreshStaff };
}

/** Заголовок раздела сервиса (единая шапка всех пяти страниц) + строка ошибки. */
export function MembersHeader({
  ws,
  title,
  description,
  actions,
  error,
  onCloseError,
  children,
}: {
  ws: Workspace;
  title: string;
  description?: string;
  actions?: ReactNode;
  error?: string;
  onCloseError?: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader
        breadcrumb={ws.name}
        title={title}
        description={description}
        chip={<Chip tone="accent" icon="people">{ws.membersCount} чел.</Chip>}
        actions={actions}
      />
      {error && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          <Alert tone="danger" onClose={onCloseError}>{error}</Alert>
        </div>
      )}
      {children}
    </>
  );
}

/** Строка справочника: значок + название + мета + удаление. */
export function DirectoryRow({
  icon,
  title,
  subtitle,
  indent = 0,
  chips,
  onRemove,
  onClick,
}: {
  icon: 'position' | 'department' | 'branch';
  title: string;
  subtitle?: string;
  indent?: number;
  chips?: ReactNode;
  onRemove?: () => void;
  onClick?: () => void;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
        marginLeft: indent, padding: '0.5rem 0.75rem',
        border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      <Icon name={icon} size={18} style={{ color: 'var(--muted)' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="title-sm">{title}</span>
        {subtitle && <span className="label-sm" style={{ display: 'block', marginTop: '0.125rem' }}>{subtitle}</span>}
      </span>
      {chips}
      {onRemove && <IconButton icon="delete" label={`Удалить «${title}»`} size={30} onClick={(e) => { e.stopPropagation(); onRemove(); }} />}
    </div>
  );
}

/**
 * Блок выбора чипами — та же форма, что RolePicker в «Моё окружение»:
 * подпись сверху, матовые чипы кита в flex-wrap. single = одно значение,
 * multi = несколько (объекты).
 */
export function ChipPickerBlock({
  label, icon, options, selected, onToggle, emptyHint,
}: {
  label: string;
  icon: 'position' | 'branch';
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  emptyHint: string;
}) {
  return (
    <Field label={label}>
      {options.length === 0 ? (
        <p className="label-sm" style={{ margin: 0 }}>{emptyHint}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
          {options.map((o) => (
            <Chip
              key={o.id}
              size="sm"
              tone="accent"
              icon={icon}
              selected={selected.includes(o.id)}
              onClick={() => onToggle(o.id)}
            >
              {o.label}
            </Chip>
          ))}
        </div>
      )}
    </Field>
  );
}

/**
 * Реквизитный блок сотрудника (договоры, трудоустройство, выплаты). Один компонент
 * на два места — модалка ростера и вкладка «Реквизиты» профиля (второй раз не
 * переписывать: данные приезжают с ростером ТОЛЬКО управляющим либо по флагам
 * «Видимости в Компаниях» самого человека).
 */
export function MemberRequisitesBlock({ req, title = 'Реквизиты' }: { req: NonNullable<WorkspaceMember['requisites']>; title?: string }) {
  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'ИИН', value: req.iin },
    {
      label: 'Дата рождения',
      value: req.dateOfBirth ? new Date(req.dateOfBirth).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
    },
    { label: 'Адрес проживания', value: req.residentialAddress },
    {
      label: 'Удостоверение',
      value: req.idDocNumber
        ? `№ ${req.idDocNumber}${req.idDocIssuedBy ? `, ${req.idDocIssuedBy}` : ''}${req.idDocIssuedAt ? `, от ${new Date(req.idDocIssuedAt).toLocaleDateString('ru-RU')}` : ''}`
        : null,
    },
    {
      label: 'Карта для выплат',
      value: req.paymentCard
        ? `${req.paymentCard.pan.replace(/(\d{4})(?=\d)/g, '$1 ')} · ${req.paymentCard.holderName}${req.paymentCard.iban ? ` · ${req.paymentCard.iban}` : ''}`
        : null,
    },
  ].filter((r) => !!r.value);
  if (!rows.length) return null;
  return (
    <div>
      <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>{title}</div>
      <div className="ui-stack" style={{ gap: '0.25rem' }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', gap: 'var(--spacing-3)', fontSize: '0.85rem', lineHeight: 1.6, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--on-surface-variant)', minWidth: 140 }}>{r.label}</span>
            <span style={{ fontWeight: 500 }}>{r.value}</span>
          </div>
        ))}
      </div>
      <p className="label-sm" style={{ margin: 'var(--spacing-2) 0 0', opacity: 0.6 }}>
        Данные для договоров и выплат. Сотрудник видит их в своей анкете; коллегам они не показываются.
      </p>
    </div>
  );
}
