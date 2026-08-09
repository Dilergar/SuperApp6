'use client';

// ============================================================
// Сервис «Документы» (B2B) — раздел организации.
//
// Одна страница с вкладками, а не второй уровень сайдбара: у документов
// одна сущность в центре (карточка документа), а «Шаблоны» и «Виды» —
// настройка, к которой сотрудник не ходит вовсе. Настройку закрывает роль,
// реальный гейт — серверный 403.
// ============================================================

import { useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  DOC_STATUSES,
  WORKSPACE_ROLE_RANK,
  type DocStatus,
  type Workspace,
  type WorkspaceRole,
} from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import { docTypesKey, orgDocumentsKey, workspaceKey } from '@/lib/queries';
import {
  BentoGrid,
  Button,
  Card,
  Chip,
  EmptyState,
  LoadingBlock,
  PageHeader,
  SearchField,
  Select,
  Tabs,
  type TabItem,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { useApprovalsCount } from '@/lib/hooks/useApprovalsCount';
import { SubmitDocumentModal } from './SubmitDocumentModal';
import { CreateFreeDocumentModal } from './CreateFreeDocumentModal';
import { DecisionsTab } from './DecisionsTab';
import { TemplatesTab } from './TemplatesTab';
import { DocTypesTab } from './DocTypesTab';
import { fetchDocTypes, fetchOrgDocuments } from './documents-api';
import { DocStatusChip } from './documents-ui';

type TabKey = 'registry' | 'decisions' | 'mine' | 'submissions' | 'templates' | 'types';

export default function WorkspaceDocumentsPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const meId = useAuthStore((s) => s.user?.id ?? null);

  // ?subject=<id> — переход из карточки сотрудника «Его документы»: реестр сразу
  // отфильтрован по человеку, а не «вот весь список, ищите сами».
  const params = useSearchParams();
  const subjectFromUrl = params.get('subject');

  const [tab, setTab] = useState<TabKey>('registry');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<DocStatus | null>(null);
  const [docTypeId, setDocTypeId] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [freeOpen, setFreeOpen] = useState(false);

  const wsQuery = useQuery({
    queryKey: workspaceKey(id),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${id}`),
    enabled: isReady,
  });
  const myRole = wsQuery.data?.myRole as WorkspaceRole | undefined;
  const isManager = !!myRole && (WORKSPACE_ROLE_RANK[myRole] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
  // Тот же счётчик, что в бейдже топбара — общий хук, а не второй запрос.
  const decisionsCount = useApprovalsCount(isReady, { workspaceId: id });

  const typesQuery = useQuery({
    queryKey: docTypesKey(id),
    queryFn: () => fetchDocTypes(id),
    enabled: isReady && !!wsQuery.data,
  });

  // «Мои документы» — где я СТОРОНА (приказ обо мне тоже мой), «Заявления» — что я
  // подал сам. Это разные вопросы: приказ на меня пишет кадровик, а не я.
  const isList = tab === 'registry' || tab === 'mine' || tab === 'submissions';
  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      status: status ?? undefined,
      docTypeId: docTypeId ?? undefined,
      subjectUserId:
        tab === 'mine' ? (meId ?? undefined) : tab === 'registry' ? (subjectFromUrl ?? undefined) : undefined,
      createdById: tab === 'submissions' ? (meId ?? undefined) : undefined,
    }),
    [search, status, docTypeId, tab, meId, subjectFromUrl],
  );

  const listQuery = useQuery({
    queryKey: orgDocumentsKey(id, filters as Record<string, string | undefined>),
    queryFn: () => fetchOrgDocuments(id, filters),
    enabled: isReady && !!wsQuery.data && isList,
  });

  if (!isReady || wsQuery.isPending) return <LoadingBlock />;

  const header = (
    <PageHeader
      breadcrumb={wsQuery.data?.name ?? 'Организация'}
      title="Документы"
      description="Заявления, приказы и справки организации: подача, согласование, номер и место в деле"
      actions={
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          <Button variant="matte" icon="edit" onClick={() => setFreeOpen(true)}>
            Создать документ
          </Button>
          <Button icon="add" onClick={() => setSubmitOpen(true)}>
            Подать заявление
          </Button>
        </div>
      }
    />
  );

  if (wsQuery.isError) {
    return (
      <>
        {header}
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title="Организация не открылась"
              description="Возможно, у вас нет доступа. Обновите страницу или вернитесь к списку организаций."
              action={
                <Button variant="matte" icon="dashboard" href="/dashboard">
                  На главную
                </Button>
              }
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const tabs: TabItem<TabKey>[] = [
    { key: 'registry', label: 'Реестр', icon: 'list' },
    { key: 'decisions', label: 'Ждут решения', icon: 'check', count: decisionsCount || undefined },
    { key: 'mine', label: 'Мои документы', icon: 'file' },
    { key: 'submissions', label: 'Заявления', icon: 'send' },
    ...(isManager
      ? ([
          { key: 'templates', label: 'Шаблоны', icon: 'filePlus' },
          { key: 'types', label: 'Виды', icon: 'folder' },
        ] as TabItem<TabKey>[])
      : []),
  ];

  return (
    <>
      {header}

      <Tabs items={tabs} value={tab} onChange={setTab} aria-label="Разделы документов" />

      {tab === 'decisions' && <DecisionsTab workspaceId={id} />}

      {isList && (
        <>
          <div
            style={{
              display: 'flex',
              gap: 'var(--spacing-3)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              margin: 'var(--gap-grid) 0',
            }}
          >
            <SearchField
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Название или номер"
              aria-label="Поиск по документам"
            />
            <Select
              label="Вид"
              value={docTypeId}
              onChange={(v) => setDocTypeId(v || null)}
              options={[
                { value: '', label: 'Все виды' },
                ...(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name })),
              ]}
              placeholder="Все виды"
              width={200}
            />
            <Select
              label="Статус"
              value={status}
              onChange={(v) => setStatus((v || null) as DocStatus | null)}
              options={[
                { value: '', label: 'Любой' },
                ...DOC_STATUSES.map((s) => ({ value: s.value, label: s.label })),
              ]}
              placeholder="Любой"
              width={190}
            />
          </div>

          <BentoGrid>
            <Card span={12}>
              {listQuery.isPending ? (
                <LoadingBlock />
              ) : listQuery.isError ? (
                <EmptyState
                  icon="warningCircle"
                  title="Не удалось загрузить реестр"
                  action={
                    <Button variant="matte" icon="refresh" onClick={() => listQuery.refetch()}>
                      Повторить
                    </Button>
                  }
                />
              ) : (listQuery.data?.items ?? []).length === 0 ? (
                <EmptyState
                  icon="file"
                  title={
                    tab === 'submissions'
                      ? 'Вы пока ничего не подавали'
                      : tab === 'mine'
                        ? 'Документов о вас пока нет'
                        : 'Документов пока нет'
                  }
                  description={
                    tab === 'registry'
                      ? 'Здесь появятся заявления и приказы организации.'
                      : 'Нажмите «Подать заявление» — доступные вам шаблоны появятся в списке.'
                  }
                />
              ) : (
                <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
                  {(listQuery.data?.items ?? []).map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className="ui-row"
                      onClick={() => router.push(`/workspaces/${id}/documents/${doc.id}`)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--spacing-3)',
                        width: '100%',
                        textAlign: 'left',
                        padding: 'var(--spacing-3)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-item)',
                        background: 'var(--surface)',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {doc.number ? `${doc.number} · ` : ''}
                          {doc.title}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                          {doc.docTypeName}
                          {doc.templateName ? ` · ${doc.templateName}` : ''}
                        </div>
                      </div>
                      {doc.subjectUserId && (
                        <PersonChip size="M" userId={doc.subjectUserId} firstName={doc.subjectName ?? "Сотрудник"} />
                      )}
                      <DocStatusChip status={doc.status} />
                    </button>
                  ))}
                  {(listQuery.data?.total ?? 0) > (listQuery.data?.items ?? []).length && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
                      Показано {(listQuery.data?.items ?? []).length} из {listQuery.data?.total}. Уточните
                      фильтры, чтобы найти нужное.
                    </p>
                  )}
                </div>
              )}
            </Card>
          </BentoGrid>
        </>
      )}

      {tab === 'templates' && isManager && <TemplatesTab workspaceId={id} />}
      {tab === 'types' && isManager && <DocTypesTab workspaceId={id} />}

      <SubmitDocumentModal workspaceId={id} open={submitOpen} onClose={() => setSubmitOpen(false)} />
      <CreateFreeDocumentModal
        workspaceId={id}
        open={freeOpen}
        isManager={isManager}
        onClose={() => setFreeOpen(false)}
      />
    </>
  );
}
