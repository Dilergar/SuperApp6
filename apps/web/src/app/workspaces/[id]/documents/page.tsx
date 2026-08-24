'use client';

// ============================================================
// Сервис «Документы» (B2B) — раздел организации.
//
// Одна страница с вкладками, а не второй уровень сайдбара: у документов
// одна сущность в центре (карточка документа), а «Шаблоны» и «Виды» —
// настройка, к которой сотрудник не ходит вовсе. Настройку закрывает роль,
// реальный гейт — серверный 403.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
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
  Icon,
  LoadingBlock,
  Menu,
  PageHeader,
  SearchField,
  Select,
  SegmentedControl,
  type TabItem,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { useApprovalsCount } from '@/lib/hooks/useApprovalsCount';
import { SubmitDocumentModal } from './SubmitDocumentModal';
import { CreateFreeDocumentModal } from './CreateFreeDocumentModal';
import { UploadDocumentModal } from './UploadDocumentModal';
import { DecisionsTab } from './DecisionsTab';
import { CampaignsTab } from './CampaignsTab';
import { TemplatesTab } from './TemplatesTab';
import { DocTypesTab } from './DocTypesTab';
import { fetchDocTypes, fetchOrgDocuments } from './documents-api';
import { DocStatusChip } from './documents-ui';

type TabKey = 'registry' | 'external' | 'decisions' | 'campaigns' | 'mine' | 'submissions' | 'templates' | 'types';

export default function WorkspaceDocumentsPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const meId = useAuthStore((s) => s.user?.id ?? null);

  // ?subject=<id> — переход из карточки сотрудника «Его документы»: реестр сразу
  // отфильтрован по человеку. ?counterparty=<id> — из карточки контрагента:
  // открывается вкладка «С контрагентами», уже суженная до него.
  const params = useSearchParams();
  const subjectFromUrl = params.get('subject');
  const counterpartyFromUrl = params.get('counterparty');
  // ?tab=campaigns — дип-линки из уведомлений кампаний ознакомления (КЭДО)
  const tabFromUrl = params.get('tab');

  const [tab, setTab] = useState<TabKey>(
    tabFromUrl === 'campaigns' ? 'campaigns' : counterpartyFromUrl ? 'external' : 'registry',
  );
  // Клиентский переход по дип-линку (?tab=campaigns из уведомления, когда
  // страница уже открыта) меняет только query — вкладку переключает эффект.
  useEffect(() => {
    if (tabFromUrl === 'campaigns') setTab('campaigns');
    else if (counterpartyFromUrl) setTab('external');
  }, [tabFromUrl, counterpartyFromUrl]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<DocStatus | null>(null);
  const [docTypeId, setDocTypeId] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [freeOpen, setFreeOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [externalSubmitOpen, setExternalSubmitOpen] = useState(false);

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
  // подал сам. «С контрагентами» — внешний контур (category=external): у него
  // вторая сторона — контрагент, а не сотрудник.
  const isList = tab === 'registry' || tab === 'external' || tab === 'mine' || tab === 'submissions';
  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      status: status ?? undefined,
      docTypeId: docTypeId ?? undefined,
      category: tab === 'external' ? 'external' : undefined,
      counterpartyId: tab === 'external' ? (counterpartyFromUrl ?? undefined) : undefined,
      subjectUserId:
        tab === 'mine' ? (meId ?? undefined) : tab === 'registry' ? (subjectFromUrl ?? undefined) : undefined,
      createdById: tab === 'submissions' ? (meId ?? undefined) : undefined,
    }),
    [search, status, docTypeId, tab, meId, subjectFromUrl, counterpartyFromUrl],
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
      title="Документооборот"
      description="Внутренние документы и договоры с контрагентами: подача, подпись, номер и место в деле"
      actions={
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          {/* Три пути создания без третьей кнопки в ряд: свободный документ в
              конструкторе и загрузка готового файла живут под одним «Создать».
              Триггер — нативная кнопка классами кита: Menu якорится по ref,
              а компонент Button ref не пробрасывает. */}
          <Menu
            label="Создать"
            items={[
              { key: 'free', label: 'Свободный документ', icon: 'edit', onClick: () => setFreeOpen(true) },
              { key: 'upload', label: 'Загрузить готовый файл', icon: 'upload', onClick: () => setUploadOpen(true) },
            ]}
            trigger={(props) => (
              <button {...props} type="button" className="ui-btn ui-btn--matte ui-btn--md">
                <Icon name="add" size={17} />
                Создать
                <Icon name="caretDown" size={15} />
              </button>
            )}
          />
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
    // Внешний контур СРАЗУ после общего реестра (реестр продолжает показывать всё)
    { key: 'external', label: 'С контрагентами', icon: 'workspace' },
    { key: 'decisions', label: 'Ждут решения', icon: 'check', count: decisionsCount || undefined },
    // «Обо мне», а не «Мои документы»: личный пункт сайдбара «Мои документы»
    // (бессрочный архив КЭДО) — другой раздел, и два одинаковых имени с разным
    // составом путали бы (решение Этапа 9).
    { key: 'mine', label: 'Обо мне', icon: 'file' },
    { key: 'submissions', label: 'Заявления', icon: 'send' },
    ...(isManager
      ? ([
          // КЭДО: кампании ознакомления с аналитикой до человека
          { key: 'campaigns', label: 'Ознакомления', icon: 'eye' },
          { key: 'templates', label: 'Шаблоны', icon: 'filePlus' },
          { key: 'types', label: 'Виды', icon: 'folder' },
        ] as TabItem<TabKey>[])
      : []),
  ];

  return (
    <>
      {header}

      {/* Пилюли-сегменты — как «везде» (Сотрудники, переключатель контекста):
          подчёркнутые Tabs в сервисах вертикали разъезжались с остальным приложением */}
      <SegmentedControl items={tabs} value={tab} onChange={setTab} aria-label="Разделы документов" />

      {tab === 'decisions' && <DecisionsTab workspaceId={id} />}
      {tab === 'campaigns' && <CampaignsTab workspaceId={id} />}

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
            {tab === 'external' && (
              <div style={{ marginLeft: 'auto' }}>
                <Button icon="add" onClick={() => setExternalSubmitOpen(true)}>
                  Документ
                </Button>
              </div>
            )}
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

          {/* Пришли с карточки человека (?subject=…): фильтр обязан быть ВИДЕН и
              сниматься одним кликом — иначе реестр выглядит подозрительно пустым,
              и вернуться ко всем документам нечем. */}
          {tab === 'registry' && subjectFromUrl && (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
              <span className="meta">Показаны документы одного сотрудника:</span>
              <PersonChip size="S" userId={subjectFromUrl} firstName="Сотрудник" />
              <Button
                variant="ghost"
                size="sm"
                icon="close"
                onClick={() => router.replace(`/workspaces/${id}/documents`)}
              >
                Показать все
              </Button>
            </div>
          )}

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
                tab === 'external' ? (
                  <EmptyState
                    icon="workspace"
                    title="Документов с контрагентами пока нет"
                    description="Договор или АВР можно собрать по шаблону, в конструкторе — или загрузить уже готовый файл. Контрагент подпишет по ссылке, аккаунт ему не нужен."
                    action={
                      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
                        <Button variant="matte" icon="upload" onClick={() => setUploadOpen(true)}>
                          Загрузить готовый файл
                        </Button>
                        <Button icon="add" onClick={() => setExternalSubmitOpen(true)}>
                          По шаблону
                        </Button>
                      </div>
                    }
                  />
                ) : (
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
                )
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
                        flexWrap: 'wrap', // телефон: чипы переносятся, а не распирают страницу
                        gap: 'var(--spacing-3)',
                        width: '100%',
                        textAlign: 'left',
                        padding: 'var(--spacing-3)',
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
                      {/* Вторая сторона: у внешнего контура — контрагент, у кадрового — сотрудник */}
                      {doc.counterparty && (
                        <Chip size="sm" icon="workspace">
                          {doc.counterparty.name}
                        </Chip>
                      )}
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
      {/* «+ Документ» на вкладке внешнего контура — те же шаблоны, суженные до
          категории «С контрагентами»; пусто → подсказка про загрузку готового файла */}
      <SubmitDocumentModal
        workspaceId={id}
        open={externalSubmitOpen}
        onClose={() => setExternalSubmitOpen(false)}
        category="external"
        onNoTemplates={() => {
          setExternalSubmitOpen(false);
          setUploadOpen(true);
        }}
      />
      <CreateFreeDocumentModal
        workspaceId={id}
        open={freeOpen}
        isManager={isManager}
        onClose={() => setFreeOpen(false)}
      />
      <UploadDocumentModal
        workspaceId={id}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        presetCounterpartyId={counterpartyFromUrl}
      />
    </>
  );
}
