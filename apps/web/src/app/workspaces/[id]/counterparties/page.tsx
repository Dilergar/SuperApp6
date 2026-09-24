'use client';

// ============================================================
// Сервис «Контрагенты» (B2B) — справочник внешних сторон организации.
//
// ОДИН справочник на организацию: его читает «Документооборот» (договоры и АВР
// с внешней стороной), дальше — Счета, Финансы B2B, ЭСФ. Список + карточка на
// одной странице (`?open=<id>`): у справочника одна сущность в центре.
// Чтение — команда, запись — Менеджер+ (реальный гейт — серверный 403).
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNTERPARTY_FORM_OPTIONS,
  
  COUNTERPARTY_REF_TYPE,
  counterpartyFormQuery,
  ORG_FORMS,
  ORG_FORMS_WITH_LEGAL_WRAP,
  composeSignBasis,
  SIGN_BASIS_OPTIONS,
  TAX_REGIMES,
  WORKSPACE_ROLE_RANK,
  counterpartyIdKey,
  defaultKbeFor,
  isValidIinOrBin,
  type ChatterActorLite,
  type ChatterPageDto,
  type CounterpartyDto,
  type SignBasisInput,
  type CounterpartyKind,
  type Workspace,
  type WorkspaceRole,
  isHidden,
  isVisible,
  visibleOr,
  type Guarded,
} from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { RevealScope, RevealableValue } from '@/components/visibility/RevealButton';
import { apiGet } from '@/lib/api';
import { dmy } from '@/lib/dates';

import {
  counterpartiesKey,
  counterpartiesPrefix,
  counterpartyKey,
  workspaceKey,
} from '@/lib/queries';
import {
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  DatePicker,
  Divider,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  SearchField,
  Select,
  SegmentedControl,
  Textarea,
  Toggle,
  useConfirm,
  type TabItem,
} from '@/components/ui';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { ShareCardModal } from '@/app/messenger/ShareCardModal';
import { NotesPanel } from '@/components/notes/NotesPanel';
import { counterpartiesApi, fetchCounterparties, fetchCounterparty, lookupCounterparty } from './counterparties-api';

import { toastApiError } from '@/lib/api-errors';
export default function CounterpartiesPage() {
  const tdoc = useTranslations('documents');
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('open');

  const wsQuery = useQuery({
    queryKey: workspaceKey(id),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${id}`),
    enabled: isReady,
  });
  const myRole = wsQuery.data?.myRole as WorkspaceRole | undefined;
  const isManager = !!myRole && (WORKSPACE_ROLE_RANK[myRole] ?? 0) >= WORKSPACE_ROLE_RANK.manager;

  if (!isReady || wsQuery.isPending) return <LoadingBlock />;

  return openId ? (
    <CounterpartyCard workspaceId={id} counterpartyId={openId} isManager={isManager} onBack={() => router.push(`/workspaces/${id}/counterparties`)} />
  ) : (
    <CounterpartiesList workspaceId={id} wsName={wsQuery.data?.name ?? tdoc('page.orgFallback')} isManager={isManager} />
  );
}

// ============================================================
// Список
// ============================================================

function CounterpartiesList({
  workspaceId,
  wsName,
  isManager,
}: {
  workspaceId: string;
  wsName: string;
  isManager: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const tr = useTranslations('counterparties');
  const tc = useTranslations('common');
  const tdoc = useTranslations('documents');
  // «Вид» — ТОТ ЖЕ список, что в форме (COUNTERPARTY_FORM_OPTIONS): в запрос он
  // превращается общим `counterpartyFormQuery`, чтобы список и форма не разъезжались
  const [formKey, setFormKey] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      ...counterpartyFormQuery(formKey),
      archived: archived ? 'true' : undefined,
    }),
    [search, formKey, archived],
  );
  const listQuery = useInfiniteQuery({
    queryKey: counterpartiesKey(workspaceId, filters as Record<string, string | undefined>),
    queryFn: ({ pageParam }) =>
      fetchCounterparties(workspaceId, { ...filters, cursor: (pageParam as string | undefined) || undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => (listQuery.data?.pages ?? []).flatMap((p) => p.items), [listQuery.data]);

  return (
    <>
      <PageHeader
        breadcrumb={wsName}
        title={tr('breadcrumb')}
        description={tr('list.description')}
        actions={
          isManager ? (
            <Button icon="add" onClick={() => setCreateOpen(true)}>
              {tr('list.add')}
            </Button>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', flexWrap: 'wrap', margin: 'var(--gap-grid) 0' }}>
        <SearchField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tr('list.searchPlaceholder')}
          aria-label={tr('list.searchAria')}
        />
        <Select
          label={tr('list.kindFilter')}
          value={formKey}
          onChange={(v) => setFormKey(v || null)}
          options={[
            { value: '', label: tc('labels.all') },
            ...COUNTERPARTY_FORM_OPTIONS.map((o) => ({ value: o.value, label: tr(`form.${o.value}`) })),
          ]}
          placeholder={tc('labels.all')}
          width={210}
        />
        {/* Архив — не удаление: сюда уходят карточки, с которыми больше не работают,
            и отсюда же возвращаются */}
        <Chip tone="accent" selected={archived} icon="delete" onClick={() => setArchived((v) => !v)}>
          {tr('list.archived')}
        </Chip>
      </div>

      <BentoGrid>
        <Card span={12}>
          {listQuery.isPending ? (
            <LoadingBlock />
          ) : listQuery.isError ? (
            <EmptyState
              icon="warningCircle"
              title={tr('list.loadFailed')}
              action={
                <Button variant="matte" icon="refresh" onClick={() => listQuery.refetch()}>
                  {tc('actions.retry')}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            archived ? (
              <EmptyState
                icon="delete"
                title={tr('list.archiveEmpty')}
                description={tr('list.archiveEmptyText')}
                action={
                  <Button variant="matte" icon="arrowLeft" onClick={() => setArchived(false)}>
                    {tr('list.toActive')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="workspace"
                title={tr('list.emptyTitle')}
                description={tr('list.emptyText')}
                action={
                  isManager ? (
                    <Button icon="add" onClick={() => setCreateOpen(true)}>
                      {tr('list.addFirst')}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
              {rows.map((cp) => (
                <button
                  key={cp.id}
                  type="button"
                  className="ui-row"
                  onClick={() => router.push(`/workspaces/${workspaceId}/counterparties?open=${cp.id}`)}
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
                    <div style={{ fontWeight: 600 }}>{cp.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      {[cp.legalName !== cp.name ? cp.legalName : null, cp.bin ? `${tr(`idLabel.${counterpartyIdKey(cp.kind)}`)} ${cp.bin}` : null]
                        .filter(Boolean)
                        .join(' · ') || tr(formLabelKey(cp))}
                    </div>
                  </div>
                  {(cp.documentsCount ?? 0) > 0 && (
                    <Chip size="sm" icon="file">
                      {cp.documentsCount}
                    </Chip>
                  )}
                  <Chip size="sm">{tr(formLabelKey(cp))}</Chip>
                </button>
              ))}
              {listQuery.hasNextPage && (
                <div style={{ textAlign: 'center' }}>
                  <Button variant="matte" size="sm" loading={listQuery.isFetchingNextPage} onClick={() => listQuery.fetchNextPage()}>
                    {tr('list.more')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </BentoGrid>

      <CounterpartyFormModal
        workspaceId={workspaceId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={(cp) => router.push(`/workspaces/${workspaceId}/counterparties?open=${cp.id}`)}
      />
    </>
  );
}

/** КЛЮЧ подписи вида: слово даёт каталог — реестр называет только смысл */
const formLabelKey = (cp: Pick<CounterpartyDto, 'kind' | 'orgForm'>) =>
  cp.orgForm && (ORG_FORMS as readonly string[]).includes(cp.orgForm) ? `form.${cp.orgForm}` : `kind.${cp.kind}`;
  

// ============================================================
// Карточка: Реквизиты (+контакты и счета) · Хроника
// ============================================================

type CardTab = 'requisites' | 'notes' | 'chronicle';

function CounterpartyCard({
  workspaceId,
  counterpartyId,
  isManager,
  onBack,
}: {
  workspaceId: string;
  counterpartyId: string;
  isManager: boolean;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const tr = useTranslations('counterparties');
  const tc = useTranslations('common');
  const tdoc = useTranslations('documents');
  const tn = useTranslations('notes');
  const [tab, setTab] = useState<CardTab>('requisites');
  const [editOpen, setEditOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const cpQuery = useQuery({
    queryKey: counterpartyKey(workspaceId, counterpartyId),
    queryFn: () => fetchCounterparty(workspaceId, counterpartyId),
  });
  const cp = cpQuery.data;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: counterpartyKey(workspaceId, counterpartyId) });
    qc.invalidateQueries({ queryKey: counterpartiesPrefix(workspaceId) });
  };

  const archive = useMutation({
    mutationFn: () => counterpartiesApi.archive(workspaceId, counterpartyId),
    onSuccess: () => {
      refresh();
      onBack();
    },
    onError: (e) => toastApiError(e),
  });
  const restore = useMutation({
    mutationFn: () => counterpartiesApi.restore(workspaceId, counterpartyId),
    onSuccess: () => refresh(), // карточка остаётся открытой — видно, что вернулась
    onError: (e) => toastApiError(e),
  });

  if (cpQuery.isPending) return <LoadingBlock />;
  if (cpQuery.isError || !cp) {
    return (
      <>
        <PageHeader breadcrumb={tr('breadcrumb')} title={tr('card.failedTitle')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title={tr('card.notFound')}
              action={
                <Button variant="matte" icon="arrowLeft" onClick={onBack}>
                  {tr('card.back')}
                </Button>
              }
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  // Контакты и счета живут ВНУТРИ «Реквизитов» (решение продукта 2026-08-18):
  // карточка читается одной страницей; отдельной вкладкой — только длинная хроника.
  const tabs: TabItem<CardTab>[] = [
    { key: 'requisites', label: tr('card.tabRequisites'), icon: 'workspace' },
    { key: 'notes', label: tn('breadcrumb'), icon: 'notes' },
    { key: 'chronicle', label: tr('card.tabChronicle'), icon: 'journal' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={tr('breadcrumb')}
        title={cp.name}
        chip={
          cp.archivedAt ? (
            <Chip tone="danger" icon="delete">
              {tr('list.archived')}
            </Chip>
          ) : (
            <Chip size="sm">{tr(formLabelKey(cp))}</Chip>
          )
        }
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Button variant="ghost" icon="arrowLeft" onClick={onBack}>
              {tr('card.back')}
            </Button>
            <Button variant="ghost" icon="messenger" onClick={() => setShareOpen(true)}>
              {tr('card.toChat')}
            </Button>
            <Button
              variant="matte"
              icon="file"
              href={`/workspaces/${workspaceId}/documents?counterparty=${cp.id}`}
            >
              {tdoc('page.title')}
              {(cp.documentsCount ?? 0) > 0 ? ` · ${cp.documentsCount}` : ''}
            </Button>
            {isManager && !cp.archivedAt && (
              <>
                <Button variant="matte" icon="edit" onClick={() => setEditOpen(true)}>
                  {tc('actions.edit')}
                </Button>
                {/* Тот же матовый форм-фактор, что у «Документы»/«Править», но красный:
                    опасное действие — danger-тон (правило дизайн-системы) */}
                <Button
                  variant="matte"
                  tone="danger"
                  icon="delete"
                  onClick={() =>
                    confirm(
                      {
                        title: tr('card.archiveTitle'),
                        message: tr('card.archiveText'),
                        confirmLabel: tr('card.archive'),
                        danger: true,
                      },
                      async () => {
                        await archive.mutateAsync();
                      },
                    )
                  }
                >
                  {tr('card.archive')}
                </Button>
              </>
            )}
            {/* Архив обратим: карточка возвращается в справочник тем же путём,
                каким ушла (прецедент архива организаций) */}
            {isManager && cp.archivedAt && (
              <Button
                variant="matte"
                tone="success"
                icon="refresh"
                loading={restore.isPending}
                onClick={() => restore.mutate()}
              >
                {tr('card.restore')}
              </Button>
            )}
          </div>
        }
      />

      <SegmentedControl items={tabs} value={tab} onChange={setTab} aria-label={tr('card.tabsAria')} />

      {/* ОДНА BentoGrid на весь состав карточки (паттерн карточки документа):
          секции — просто Card'ы в общем гриде, ритм держит его gap */}
      {tab === 'requisites' && (
        <RevealScope>
          <BentoGrid>
            <RequisitesTab cp={cp} />
            <ContactsTab workspaceId={workspaceId} cp={cp} isManager={isManager} onChanged={refresh} />
            <AccountsTab workspaceId={workspaceId} cp={cp} isManager={isManager} onChanged={refresh} />
          </BentoGrid>
        </RevealScope>
      )}
      {tab === 'notes' && (
        <BentoGrid>
          <Card span={12}>
            <CardHeader title={tr('card.notesTitle')} subtitle={tr('card.notesSubtitle')} />
            <NotesPanel target={{ type: 'counterparty', id: cp.id }} scope={{ workspaceId }} />
          </Card>
        </BentoGrid>
      )}
      {tab === 'chronicle' && <ChronicleTab counterpartyId={cp.id} />}

      <CounterpartyFormModal
        workspaceId={workspaceId}
        open={editOpen}
        existing={cp}
        onClose={() => setEditOpen(false)}
        onSaved={refresh}
      />
      {/* Контрагент пересылается в чат живой карточкой (Принцип 3) */}
      {shareOpen && (
        <ShareCardModal
          refType={COUNTERPARTY_REF_TYPE}
          refId={cp.id}
          title={cp.name}
          onClose={() => setShareOpen(false)}
        />
      )}
      {confirmUI}
    </>
  );
}

/** Поле контакта есть и не скрыто правилами (маску рисуем символами) */
function shown<T>(v: Guarded<T | null>): boolean {
  return v !== null && v !== '' && !isHidden(v);
}

/** «Должность · телефон · e-mail» из видимых частей; пусто — тире */
function ContactLine({ parts }: { parts: React.ReactNode[] }) {
  const list = parts.filter(Boolean);
  if (!list.length) return <>—</>;
  return (
    <>
      {list.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
          {i > 0 && <span aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--text-muted)', flex: '0 0 150px' }}>{label}</span>
      {/* Длинные значения (полное юрнаименование, e-mail) переносятся, а не режутся краем карточки */}
      <span style={{ fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{children || '—'}</span>
    </div>
  );
}

function RequisitesTab({ cp }: { cp: CounterpartyDto }) {
  const tr = useTranslations('counterparties');
  const tws = useTranslations('workspaces');
  const vat = cp.vatPayer
    ? [
          cp.vatSeries ? tr('card.vatSeries', { series: cp.vatSeries }) : null,
          cp.vatNumber ? tr('card.vatNumber', { number: cp.vatNumber }) : null,
          cp.vatDate ? tr('card.vatDate', { date: dmy(cp.vatDate) }) : null,
        ]
        .filter(Boolean)
        .join(' ') || tr('card.vatPayer')
    : tr('card.vatNotPayer');
  return (
    <>
      <Card span={7}>
        <CardHeader title={tr('card.tabRequisites')} subtitle={tr('card.requisitesSubtitle')} />
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <Row label={tr('form.legalName')}>{cp.legalName ?? ''}</Row>
          <Row label={tr(`idLabel.${counterpartyIdKey(cp.kind)}`)}>{cp.bin ?? ''}</Row>
          <Row label={tr('form.legalAddress')}>{cp.legalAddress ?? ''}</Row>
          <Row label={tr('form.actualAddress')}>
            {cp.actualAddress ?? (cp.legalAddress ? tr('card.sameAsLegal') : '')}
          </Row>
          <Row label={tr('form.kbe')}>{cp.kbe ?? ''}</Row>
          <Row label={tr('form.taxRegime')}>
            {cp.taxRegime && (TAX_REGIMES as readonly string[]).includes(cp.taxRegime)
              ? tws(`taxRegime.${cp.taxRegime}`)
              : (cp.taxRegime ?? '')}
          </Row>
          <Row label={tr('card.vat')}>{vat}</Row>
        </div>
      </Card>
      <Card span={5}>
        <CardHeader title={tr('card.signAndContacts')} />
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <Row label={tr('form.director')}>{cp.directorName ?? ''}</Row>
          <Row label={tr('form.signBasis')}>{cp.signBasis ?? ''}</Row>
          {!isHidden(cp.phone) && (
            <Row label={tr('card.phone')}>
              <RevealableValue value={cp.phone} recordType="counterparty" recordId={cp.id} field="phone" />
            </Row>
          )}
          {!isHidden(cp.email) && (
            <Row label="E-mail">
              <RevealableValue value={cp.email} recordType="counterparty" recordId={cp.id} field="email" />
            </Row>
          )}
        </div>
        {cp.comment && (
          <>
            <Divider />
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>{cp.comment}</p>
          </>
        )}
      </Card>
    </>
  );
}

// ============================================================
// Контакты
// ============================================================

function ContactsTab({
  workspaceId,
  cp,
  isManager,
  onChanged,
}: {
  workspaceId: string;
  cp: CounterpartyDto;
  isManager: boolean;
  onChanged: () => void;
}) {
  const [confirm, confirmUI] = useConfirm();
  const [name, setName] = useState('');
  const tr = useTranslations('counterparties');
  const tc = useTranslations('common');
  const [position, setPosition] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const add = useMutation({
    mutationFn: () =>
      counterpartiesApi.addContact(workspaceId, cp.id, {
        name: name.trim(),
        position: position.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
      }),
    onSuccess: () => {
      setName('');
      setPosition('');
      setPhone('');
      setEmail('');
      onChanged();
    },
    onError: (e) => toastApiError(e),
  });
  const remove = useMutation({
    mutationFn: (contactId: string) => counterpartiesApi.removeContact(workspaceId, cp.id, contactId),
    onSuccess: onChanged,
    onError: (e) => toastApiError(e),
  });

  return (
    <>
      <Card span={7}>
        <CardHeader
          title={tr('contacts.title')}
          subtitle={tr('contacts.subtitle')}
        />
        {cp.contacts.length === 0 ? (
          <EmptyState
            icon="people"
            title={tr('contacts.emptyTitle')}
            description={tr('contacts.emptyText')}
          />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
            {cp.contacts.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-3)',
                  padding: 'var(--spacing-3)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', display: 'flex', flexWrap: 'wrap', gap: '0 var(--spacing-2)', alignItems: 'center' }}>
                    <ContactLine
                      parts={[
                        c.position ? <span key="p">{c.position}</span> : null,
                        shown(c.phone) ? <RevealableValue key="t" value={c.phone} recordType="counterparty" recordId={c.id} field="contactPhone" /> : null,
                        shown(c.email) ? <RevealableValue key="e" value={c.email} recordType="counterparty" recordId={c.id} field="contactEmail" /> : null,
                      ]}
                    />
                  </div>
                </div>
                {isManager && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="close"
                    onClick={() =>
                      confirm(
                        {
                          title: tr('contacts.removeTitle', { name: c.name }),
                          message: tr('contacts.removeText'),
                          confirmLabel: tc('actions.remove'),
                          danger: true,
                        },
                        async () => {
                          await remove.mutateAsync(c.id);
                        },
                      )
                    }
                  >
                    {tc('actions.remove')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {isManager && (
        <Card span={5}>
          <CardHeader title={tr('contacts.add')} />
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            <Input label={tr('contacts.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('contacts.namePlaceholder')} />
            <Input
              label={tr('contacts.position')}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder={tr('contacts.positionPlaceholder')}
            />
            <Input
              label={tr('contacts.phone')}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 777 123 45 67"
            />
            <Input label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@company.kz" />
            <div>
              <Button icon="add" loading={add.isPending} disabled={!name.trim()} onClick={() => add.mutate()}>
                {tc('actions.add')}
              </Button>
            </div>
          </div>
        </Card>
      )}
      {confirmUI}
    </>
  );
}

// ============================================================
// Счета
// ============================================================

function AccountsTab({
  workspaceId,
  cp,
  isManager,
  onChanged,
}: {
  workspaceId: string;
  cp: CounterpartyDto;
  isManager: boolean;
  onChanged: () => void;
}) {
  const [confirm, confirmUI] = useConfirm();
  const [iban, setIban] = useState('');
  const tr = useTranslations('counterparties');
  const tc = useTranslations('common');
  const [bankName, setBankName] = useState('');
  const [bik, setBik] = useState('');

  const add = useMutation({
    mutationFn: () =>
      counterpartiesApi.addAccount(workspaceId, cp.id, {
        iban: iban.trim(),
        bankName: bankName.trim(),
        bik: bik.trim(),
      }),
    onSuccess: () => {
      setIban('');
      setBankName('');
      setBik('');
      onChanged();
    },
    onError: (e) => toastApiError(e),
  });
  const setPrimary = useMutation({
    mutationFn: (accId: string) => counterpartiesApi.setPrimaryAccount(workspaceId, cp.id, accId),
    onSuccess: onChanged,
    onError: (e) => toastApiError(e),
  });
  const remove = useMutation({
    mutationFn: (accId: string) => counterpartiesApi.removeAccount(workspaceId, cp.id, accId),
    onSuccess: onChanged,
    onError: (e) => toastApiError(e),
  });

  return (
    <>
      <Card span={7}>
        <CardHeader title={tr('accounts.title')} subtitle={tr('accounts.subtitle')} />
        {cp.bankAccounts.length === 0 ? (
          <EmptyState icon="card" title={tr('accounts.empty')} />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
            {cp.bankAccounts.map((a) => (
              <div
                key={a.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-3)',
                  padding: 'var(--spacing-3)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>
                    <RevealableValue value={a.iban} recordType="counterparty" recordId={a.id} field="iban" />
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {a.bankName} · {tr('accounts.bik')} {a.bik}
                  </div>
                </div>
                {a.isPrimary ? (
                  <Chip size="sm" tone="accent">
                    {tr('accounts.primary')}
                  </Chip>
                ) : (
                  isManager && (
                    <Button variant="ghost" size="sm" loading={setPrimary.isPending} onClick={() => setPrimary.mutate(a.id)}>
                      {tr('accounts.makePrimary')}
                    </Button>
                  )
                )}
                {isManager && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="close"
                    onClick={() =>
                      confirm(
                        { title: tr('accounts.deleteTitle'), confirmLabel: tc('actions.delete'), danger: true },
                        async () => {
                          await remove.mutateAsync(a.id);
                        },
                      )
                    }
                  >
                    {tc('actions.delete')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {isManager && (
        <Card span={5}>
          <CardHeader title={tr('accounts.add')} subtitle={tr('accounts.addHint')} />
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            <Input label={tr('accounts.iban')} value={iban} onChange={(e) => setIban(e.target.value)} placeholder="KZ86125KZT5004100100" />
            <Input
              label={tr('accounts.bank')}
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder={tr('accounts.bankPlaceholder')}
            />
            <Input label={tr('accounts.bikRequired')} value={bik} onChange={(e) => setBik(e.target.value)} placeholder="HSBKKZKX" />
            <div>
              <Button
                icon="add"
                loading={add.isPending}
                disabled={!iban.trim() || !bankName.trim() || !bik.trim()}
                onClick={() => add.mutate()}
              >
                {tc('actions.add')}
              </Button>
            </div>
          </div>
        </Card>
      )}
      {confirmUI}
    </>
  );
}

function ChronicleTab({ counterpartyId }: { counterpartyId: string }) {
  const tr = useTranslations('counterparties');
  const chronicleQuery = useInfiniteQuery({
    queryKey: ['chatter', COUNTERPARTY_REF_TYPE, counterpartyId],
    queryFn: async ({ pageParam }) =>
      apiGet<ChatterPageDto>(`/chatter/${COUNTERPARTY_REF_TYPE}/${counterpartyId}`, {
        params: { cursor: (pageParam as string | undefined) || undefined },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = useMemo(() => (chronicleQuery.data?.pages ?? []).flatMap((p) => p.items), [chronicleQuery.data]);
  const actors = useMemo(() => {
    const merged: Record<string, ChatterActorLite> = {};
    for (const p of chronicleQuery.data?.pages ?? []) Object.assign(merged, p.actors);
    return merged;
  }, [chronicleQuery.data]);

  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader title={tr('card.chronicle')} />
        {chronicleQuery.isPending ? (
          <LoadingBlock />
        ) : (
          <ChronicleFeed entries={entries as never[]} actors={actors} emptyText={tr('card.chronicleEmpty')} />
        )}
      </Card>
    </BentoGrid>
  );
}

// ============================================================
// Форма карточки (создание и правка)
// ============================================================

/** Дата → YYYY-MM-DD по местному календарю (toISOString сдвинул бы день поясом) */
const toYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Полное юрнаименование по орг-форме. Порядок слов принадлежит ЯЗЫКУ (в казахском
 * форма стоит ПОСЛЕ названия), поэтому фраза берётся из каталога целиком, а куски
 * «до» и «после» вычисляются по месту подстановки.
 */
const NAME_MARK = '\u0000';

function legalWrapOf(
  tr: (key: string, values?: Record<string, string>) => string,
  form: string,
): { pre: string; post: string } | null {
  if (!(ORG_FORMS_WITH_LEGAL_WRAP as readonly string[]).includes(form)) return null;
  const phrase = tr(`orgFormLegal.${form}`, { name: NAME_MARK });
  const at = phrase.indexOf(NAME_MARK);
  if (at === -1) return null;
  return { pre: phrase.slice(0, at), post: phrase.slice(at + NAME_MARK.length) };
}

/** Снять известную приставку полной формы («Товарищество … «Ромашка»» → «Ромашка») */
function stripLegalWrap(full: string, tr: (key: string, values?: Record<string, string>) => string): string {
  for (const form of ORG_FORMS_WITH_LEGAL_WRAP) {
    const w = legalWrapOf(tr, form);
    if (w && full.startsWith(w.pre) && full.endsWith(w.post) && full.length > w.pre.length + w.post.length) {
      return w.post ? full.slice(w.pre.length, -w.post.length) : full.slice(w.pre.length);
    }
  }
  return full;
}

function CounterpartyFormModal({
  workspaceId,
  open,
  existing,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  open: boolean;
  existing?: CounterpartyDto;
  onClose: () => void;
  onSaved: (cp: CounterpartyDto) => void;
}) {
  const qc = useQueryClient();
  const tr = useTranslations('counterparties');
  const tc = useTranslations('common');
  const tws = useTranslations('workspaces');

  // «Вид» — ЕДИНЫЙ список орг-форм РК: kind (БИН/ИИН, сверка ЭЦП) и приставка
  // юрнаименования выводятся из выбора сами (решение продукта 2026-08-18)
  const [formKey, setFormKey] = useState<string>(() => {
    if (!existing) return 'too';
    if (existing.orgForm && COUNTERPARTY_FORM_OPTIONS.some((o) => o.orgForm === existing.orgForm)) {
      return existing.orgForm;
    }
    if (existing.kind === 'individual') return 'individual';
    if (existing.kind === 'entrepreneur') return 'ip';
    return 'other';
  });
  const option = COUNTERPARTY_FORM_OPTIONS.find((o) => o.value === formKey) ?? COUNTERPARTY_FORM_OPTIONS[0];
  const kind = option.kind as CounterpartyKind;
  const wrap = option.orgForm ? legalWrapOf(tws, option.orgForm) : null;

  const [name, setName] = useState(existing?.name ?? '');
  // Юрнаименование: человек вводит ТОЛЬКО название, полную приставку даёт вид
  const [legalBare, setLegalBare] = useState(() => (existing?.legalName ? stripLegalWrap(existing.legalName, tws) : ''));
  const [legalTouched, setLegalTouched] = useState(!!existing?.legalName);
  const legalFull =
    kind === 'individual'
      ? name.trim()
      : wrap && legalBare.trim()
        ? `${wrap.pre}${legalBare.trim()}${wrap.post}`
        : legalBare.trim();

  const [bin, setBin] = useState(existing?.bin ?? '');
  const [legalAddress, setLegalAddress] = useState(existing?.legalAddress ?? '');
  const [actualAddress, setActualAddress] = useState(existing?.actualAddress ?? '');
  const [kbe, setKbe] = useState(existing ? (existing.kbe ?? '') : defaultKbeFor('legal'));
  const [taxRegime, setTaxRegime] = useState<string>(existing?.taxRegime ?? '');
  const [vatPayer, setVatPayer] = useState(existing?.vatPayer ?? false);
  const [vatSeries, setVatSeries] = useState(existing?.vatSeries ?? '');
  const [vatNumber, setVatNumber] = useState(existing?.vatNumber ?? '');
  const [vatDate, setVatDate] = useState<Date | null>(
    existing?.vatDate ? new Date(`${existing.vatDate}T00:00:00`) : null,
  );
  const [directorName, setDirectorName] = useState(existing?.directorName ?? '');
  const phoneEditable = !existing || isVisible(existing.phone);
  const emailEditable = !existing || isVisible(existing.email);
  const [phone, setPhone] = useState(existing ? (visibleOr(existing.phone, null) ?? '') : '');
  const [email, setEmail] = useState(existing ? (visibleOr(existing.email, null) ?? '') : '');
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [dupOf, setDupOf] = useState<string | null>(null);

  // Основание подписи — готовый список («…действующего на основании Устава»);
  // у документа-основания номер и дата спрашиваются РАЗДЕЛЬНО (дата — календарём).
  // На провод уезжает СТРУКТУРА: печатную строку собирает сервер на языке бланка.
  const parsedBasis = existing?.signBasisParts ?? null;
  const [basisKey, setBasisKey] = useState<string>(parsedBasis?.kind ?? (existing ? 'none' : 'ustav'));
  const [basisNumber, setBasisNumber] = useState<string>(parsedBasis?.number ?? '');
  const [basisDate, setBasisDate] = useState<Date | null>(
    parsedBasis?.date ? new Date(`${parsedBasis.date}T00:00:00`) : null,
  );
  const [basisCustom, setBasisCustom] = useState<string>(parsedBasis?.text ?? '');
  const [basisTouched, setBasisTouched] = useState(!!existing);
  const basisOption = SIGN_BASIS_OPTIONS.find((o) => o.value === basisKey);
  // Подсказка «что уйдёт в договор» — на языке ЗРИТЕЛЯ: печатать её будет сервер
  // на языке бланка, а человеку здесь важен смысл, а не байты.
  const basisPreview =
    composeSignBasis(
      {
        kind: basisKey as SignBasisInput['kind'],
        number: basisNumber.trim() || null,
        date: basisDate ? toYmd(basisDate) : null,
        text: basisCustom.trim() || null,
      },
      (key, values) => tr(key, values),
      (iso) => dmy(iso),
    ) ?? '';

  // Смена вида тянет за собой умолчания, пока человек их не трогал сам
  const changeForm = (v: string) => {
    const next = COUNTERPARTY_FORM_OPTIONS.find((o) => o.value === v);
    if (!next) return;
    const nextKind = next.kind as CounterpartyKind;
    if (!kbe.trim() || kbe.trim() === defaultKbeFor(kind)) setKbe(defaultKbeFor(nextKind));
    if (!basisTouched) {
      setBasisKey(nextKind === 'entrepreneur' ? 'svid_ip' : nextKind === 'individual' ? 'none' : 'ustav');
    }
    setFormKey(v);
  };

  // Подсказка ДО отправки: контрольная сумма ловит опечатку сразу
  const binTrimmed = bin.trim();
  const binInvalid = binTrimmed.length > 0 && !isValidIinOrBin(binTrimmed);

  const checkDup = async (value: string) => {
    setDupOf(null);
    if (!isValidIinOrBin(value) || existing) return;
    const hit = await lookupCounterparty(workspaceId, value).catch(() => null);
    if (hit) setDupOf(hit.name);
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        kind,
        orgForm: option.orgForm ?? null,
        name: name.trim(),
        legalName: legalFull || null,
        bin: binTrimmed || null,
        legalAddress: legalAddress.trim() || null,
        actualAddress: actualAddress.trim() || null,
        kbe: kbe.trim() || null,
        taxRegime: taxRegime || null,
        vatPayer,
        vatSeries: vatPayer ? vatSeries.trim() || null : null,
        vatNumber: vatPayer ? vatNumber.trim() || null : null,
        vatDate: vatPayer && vatDate ? toYmd(vatDate) : null,
        directorName: directorName.trim() || null,
        signBasis:
          basisKey === 'none'
            ? null
            : {
                kind: basisKey as SignBasisInput['kind'],
                ...(basisOption?.needsDetail && basisNumber.trim() ? { number: basisNumber.trim() } : {}),
                ...(basisOption?.needsDetail && basisDate ? { date: toYmd(basisDate) } : {}),
                ...(basisKey === 'custom' ? { text: basisCustom.trim() } : {}),
              },
        ...(phoneEditable ? { phone: phone.trim() || null } : {}),
        ...(emailEditable ? { email: email.trim() || null } : {}),
        comment: comment.trim() || null,
      };
      return existing
        ? counterpartiesApi.update(workspaceId, existing.id, body)
        : counterpartiesApi.create(workspaceId, body);
    },
    onSuccess: (cp) => {
      qc.invalidateQueries({ queryKey: counterpartiesPrefix(workspaceId) });
      if (existing) qc.invalidateQueries({ queryKey: counterpartyKey(workspaceId, existing.id) });
      onClose();
      onSaved(cp);
    },
    onError: (e) => toastApiError(e),
  });

  // auto-fit: на телефоне колонки схлопываются в одну сами, без брейкпоинтов
  const twoCols = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 'var(--spacing-3)',
  } as const;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr(existing ? 'form.editTitle' : 'form.newTitle')}
      subtitle={tr('card.requisitesSubtitle')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button
            icon="check"
            loading={save.isPending}
            disabled={!name.trim() || binInvalid}
            onClick={() => save.mutate()}
          >
            {tc(existing ? 'actions.save' : 'actions.add')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Select
          label={tr('list.kindFilter')}
          value={formKey}
          onChange={changeForm}
          options={COUNTERPARTY_FORM_OPTIONS.map((o) => ({ value: o.value, label: tr(`form.${o.value}`) }))}
        />
        <Input
          label={tr(kind === 'individual' ? 'form.fullName' : 'form.name')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!legalTouched) setLegalBare(e.target.value);
          }}
          placeholder={tr(kind === 'individual' ? 'form.fullNamePlaceholder' : 'form.namePlaceholder')}
        />
        {kind !== 'individual' &&
          (wrap ? (
            // Вид стоит ПЕРЕД полем (как БИН/ИИН меняется от вида): ТОО «…», ИП …
            <Field
              label={tr('form.legalName')}
              hint={legalFull ? tr('form.legalPreview', { name: legalFull }) : tr('form.legalHint')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{tr(`form.${option.value}`)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Input
                    aria-label={`${tr('form.legalName')} (${tr(`form.${option.value}`)})`}
                    value={legalBare}
                    onChange={(e) => {
                      setLegalBare(e.target.value);
                      setLegalTouched(true);
                    }}
                    placeholder={tr(formKey === 'ip' ? 'form.ipNamePlaceholder' : 'form.namePlaceholder')}
                  />
                </div>
              </div>
            </Field>
          ) : (
            <Input
              label={tr('form.legalName')}
              value={legalBare}
              onChange={(e) => {
                setLegalBare(e.target.value);
                setLegalTouched(true);
              }}
              placeholder={tr('form.branchNamePlaceholder')}
              hint={tr('form.freeLegalHint')}
            />
          ))}
        <Input
          label={tr(`idLabel.${counterpartyIdKey(kind)}`)}
          value={bin}
          onChange={(e) => {
            setBin(e.target.value);
            setDupOf(null);
          }}
          onBlur={() => void checkDup(binTrimmed)}
          placeholder="123456789012"
          error={binInvalid ? tr('form.binInvalid') : dupOf ? tr('form.binDuplicate', { name: dupOf }) : undefined}
        />
        <div style={twoCols}>
          <Input
            label={tr('form.legalAddress')}
            value={legalAddress}
            onChange={(e) => setLegalAddress(e.target.value)}
            placeholder={tr('form.addressPlaceholder')}
          />
          <Input
            label={tr('form.actualAddress')}
            value={actualAddress}
            onChange={(e) => setActualAddress(e.target.value)}
            placeholder={tr('form.actualAddressPlaceholder')}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 'var(--spacing-3)' }}>
          <Input label={tr('form.kbe')} value={kbe} onChange={(e) => setKbe(e.target.value)} placeholder="17" />
          <Select
            label={tr('form.taxRegime')}
            value={taxRegime || null}
            onChange={(v) => setTaxRegime(v)}
            options={[
            { value: '', label: tr('form.notStated') },
            ...TAX_REGIMES.map((r) => ({ value: r, label: tws(`taxRegime.${r}`) })),
          ]}
            placeholder={tr('form.notStated')}
          />
        </div>
        <Toggle
          label={tr('form.vatPayer')}
          description={tr('form.vatPayerHint')}
          checked={vatPayer}
          onChange={setVatPayer}
        />
        {vatPayer && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--spacing-3)' }}>
            <Input label={tr('form.vatSeries')} value={vatSeries} onChange={(e) => setVatSeries(e.target.value)} placeholder="60001" />
            <Input label={tr('form.vatNumber')} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="0031205" />
            <DatePicker label={tr('form.vatDate')} value={vatDate} onChange={(d) => setVatDate(d)} />
          </div>
        )}
        {kind !== 'individual' && (
          <Input
            label={tr('form.director')}
            value={directorName}
            onChange={(e) => setDirectorName(e.target.value)}
            placeholder={tr('form.directorPlaceholder')}
          />
        )}
        <div style={twoCols}>
          <Select
            label={tr('form.signBasis')}
            hint={basisPreview ? tr('form.basisPreview', { basis: basisPreview }) : tr('form.basisHint')}
            value={basisKey}
            onChange={(v) => {
              setBasisKey(v);
              setBasisTouched(true);
            }}
            options={[
              ...SIGN_BASIS_OPTIONS.map((o) => ({ value: o.value, label: tr(`signBasis.${o.value}`) })),
              { value: 'custom', label: tr('signBasis.custom') },
              { value: 'none', label: tr('signBasis.none') },
            ]}
          />
          {basisOption?.needsDetail && basisKey !== 'custom' ? (
            <>
              <Input
                label={tr('form.basisNumber')}
                value={basisNumber}
                onChange={(e) => setBasisNumber(e.target.value)}
                placeholder={tr(`signBasisNumberExample.${basisOption.value}`)}
              />
              {/* Дата — календарём, как «Дата свидетельства»: руками «от 15.01.2026» не набирают */}
              <DatePicker label={tr('form.basisDate')} value={basisDate} onChange={(d) => setBasisDate(d)} />
            </>
          ) : basisKey === 'custom' ? (
            <Input
              label={tr('signBasis.custom')}
              value={basisCustom}
              onChange={(e) => setBasisCustom(e.target.value)}
              placeholder={tr('form.basisCustomPlaceholder')}
            />
          ) : (
            <div />
          )}
        </div>
        <div style={twoCols}>
          {phoneEditable && <Input label={tr('card.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 727 244 00 00" />}
          {emailEditable && <Input label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@company.kz" />}
        </div>
        <Textarea label={tr('form.comment')} value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
      </div>
    </Modal>
  );
}
