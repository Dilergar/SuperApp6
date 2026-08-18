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
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNTERPARTY_FORM_OPTIONS,
  COUNTERPARTY_KINDS,
  COUNTERPARTY_REF_TYPE,
  counterpartyFormQuery,
  ORG_FORMS,
  ORG_FORM_LEGAL_WRAP,
  SIGN_BASIS_OPTIONS,
  TAX_REGIMES,
  WORKSPACE_ROLE_RANK,
  counterpartyIdLabel,
  defaultKbeFor,
  isValidIinOrBin,
  type ChatterActorLite,
  type ChatterPageDto,
  type CounterpartyDto,
  type CounterpartyKind,
  type Workspace,
  type WorkspaceRole,
} from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage, apiGet } from '@/lib/api';
import { toastError } from '@/lib/toast';
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
import { counterpartiesApi, fetchCounterparties, fetchCounterparty, lookupCounterparty } from './counterparties-api';

export default function CounterpartiesPage() {
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
    <CounterpartiesList workspaceId={id} wsName={wsQuery.data?.name ?? 'Организация'} isManager={isManager} />
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
        title="Контрагенты"
        description="Справочник внешних сторон: реквизиты, контактные лица и счета — их читают договоры и будущие счета на оплату"
        actions={
          isManager ? (
            <Button icon="add" onClick={() => setCreateOpen(true)}>
              Контрагент
            </Button>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', flexWrap: 'wrap', margin: 'var(--gap-grid) 0' }}>
        <SearchField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Название, юрнаименование или БИН"
          aria-label="Поиск по контрагентам"
        />
        <Select
          label="Вид"
          value={formKey}
          onChange={(v) => setFormKey(v || null)}
          options={[
            { value: '', label: 'Все' },
            ...COUNTERPARTY_FORM_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          ]}
          placeholder="Все"
          width={210}
        />
        {/* Архив — не удаление: сюда уходят карточки, с которыми больше не работают,
            и отсюда же возвращаются */}
        <Chip tone="accent" selected={archived} icon="delete" onClick={() => setArchived((v) => !v)}>
          В архиве
        </Chip>
      </div>

      <BentoGrid>
        <Card span={12}>
          {listQuery.isPending ? (
            <LoadingBlock />
          ) : listQuery.isError ? (
            <EmptyState
              icon="warningCircle"
              title="Справочник не загрузился"
              action={
                <Button variant="matte" icon="refresh" onClick={() => listQuery.refetch()}>
                  Повторить
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            archived ? (
              <EmptyState
                icon="delete"
                title="В архиве пусто"
                description="Сюда попадают карточки, убранные из справочника. Вернуть их можно в любой момент."
                action={
                  <Button variant="matte" icon="arrowLeft" onClick={() => setArchived(false)}>
                    К действующим
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="workspace"
                title="Контрагентов пока нет"
                description="Заведите тех, с кем заключаете договоры: их реквизиты подставятся в документы, а контактное лицо получит ссылку на подписание."
                action={
                  isManager ? (
                    <Button icon="add" onClick={() => setCreateOpen(true)}>
                      Добавить контрагента
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
                      {[cp.legalName !== cp.name ? cp.legalName : null, cp.bin ? `${counterpartyIdLabel(cp.kind)} ${cp.bin}` : null]
                        .filter(Boolean)
                        .join(' · ') || FORM_LABEL(cp)}
                    </div>
                  </div>
                  {(cp.documentsCount ?? 0) > 0 && (
                    <Chip size="sm" icon="file">
                      {cp.documentsCount}
                    </Chip>
                  )}
                  <Chip size="sm">{FORM_LABEL(cp)}</Chip>
                </button>
              ))}
              {listQuery.hasNextPage && (
                <div style={{ textAlign: 'center' }}>
                  <Button variant="matte" size="sm" loading={listQuery.isFetchingNextPage} onClick={() => listQuery.fetchNextPage()}>
                    Показать ещё
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

const KIND_LABEL = (kind: CounterpartyKind) => COUNTERPARTY_KINDS.find((k) => k.value === kind)?.label ?? kind;
/** Подпись вида: орг-форма (ТОО/АО/…), а без неё — широкий вид (юрлицо/ИП/физлицо) */
const FORM_LABEL = (cp: Pick<CounterpartyDto, 'kind' | 'orgForm'>) =>
  (cp.orgForm ? ORG_FORMS.find((f) => f.value === cp.orgForm)?.label : null) ?? KIND_LABEL(cp.kind);

// ============================================================
// Карточка: Реквизиты (+контакты и счета) · Хроника
// ============================================================

type CardTab = 'requisites' | 'chronicle';

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
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: () => counterpartiesApi.restore(workspaceId, counterpartyId),
    onSuccess: () => refresh(), // карточка остаётся открытой — видно, что вернулась
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (cpQuery.isPending) return <LoadingBlock />;
  if (cpQuery.isError || !cp) {
    return (
      <>
        <PageHeader breadcrumb="Контрагенты" title="Карточка не открылась" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title="Контрагент не найден"
              action={
                <Button variant="matte" icon="arrowLeft" onClick={onBack}>
                  К справочнику
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
    { key: 'requisites', label: 'Реквизиты', icon: 'workspace' },
    { key: 'chronicle', label: 'Хроника', icon: 'journal' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb="Контрагенты"
        title={cp.name}
        chip={
          cp.archivedAt ? (
            <Chip tone="danger" icon="delete">
              В архиве
            </Chip>
          ) : (
            <Chip size="sm">{FORM_LABEL(cp)}</Chip>
          )
        }
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Button variant="ghost" icon="arrowLeft" onClick={onBack}>
              К справочнику
            </Button>
            <Button variant="ghost" icon="messenger" onClick={() => setShareOpen(true)}>
              В чат
            </Button>
            <Button
              variant="matte"
              icon="file"
              href={`/workspaces/${workspaceId}/documents?counterparty=${cp.id}`}
            >
              Документы{(cp.documentsCount ?? 0) > 0 ? ` · ${cp.documentsCount}` : ''}
            </Button>
            {isManager && !cp.archivedAt && (
              <>
                <Button variant="matte" icon="edit" onClick={() => setEditOpen(true)}>
                  Править
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
                        title: 'Убрать контрагента в архив?',
                        message: 'Документы с ним останутся в реестре. Документы в работе блокируют архив.',
                        confirmLabel: 'В архив',
                        danger: true,
                      },
                      async () => {
                        await archive.mutateAsync();
                      },
                    )
                  }
                >
                  В архив
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
                Вернуть из архива
              </Button>
            )}
          </div>
        }
      />

      <SegmentedControl items={tabs} value={tab} onChange={setTab} aria-label="Разделы карточки контрагента" />

      {/* ОДНА BentoGrid на весь состав карточки (паттерн карточки документа):
          секции — просто Card'ы в общем гриде, ритм держит его gap */}
      {tab === 'requisites' && (
        <BentoGrid>
          <RequisitesTab cp={cp} />
          <ContactsTab workspaceId={workspaceId} cp={cp} isManager={isManager} onChanged={refresh} />
          <AccountsTab workspaceId={workspaceId} cp={cp} isManager={isManager} onChanged={refresh} />
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
  const vat = cp.vatPayer
    ? [cp.vatSeries ? `серия ${cp.vatSeries}` : null, cp.vatNumber ? `№ ${cp.vatNumber}` : null, cp.vatDate ? `от ${cp.vatDate.split('-').reverse().join('.')}` : null]
        .filter(Boolean)
        .join(' ') || 'плательщик'
    : 'не плательщик';
  return (
    <>
      <Card span={7}>
        <CardHeader title="Реквизиты" subtitle="Подставляются в документы тегами {Контрагент.…}" />
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <Row label="Юридическое наименование">{cp.legalName ?? ''}</Row>
          <Row label={counterpartyIdLabel(cp.kind)}>{cp.bin ?? ''}</Row>
          <Row label="Юридический адрес">{cp.legalAddress ?? ''}</Row>
          <Row label="Фактический адрес">
            {cp.actualAddress ?? (cp.legalAddress ? 'совпадает с юридическим' : '')}
          </Row>
          <Row label="КБе">{cp.kbe ?? ''}</Row>
          <Row label="Налоговый режим">
            {cp.taxRegime ? (TAX_REGIMES.find((r) => r.value === cp.taxRegime)?.label ?? cp.taxRegime) : ''}
          </Row>
          <Row label="НДС">{vat}</Row>
        </div>
      </Card>
      <Card span={5}>
        <CardHeader title="Подпись и связь" />
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <Row label="Руководитель">{cp.directorName ?? ''}</Row>
          <Row label="Основание подписи">{cp.signBasis ?? ''}</Row>
          <Row label="Телефон">{cp.phone ?? ''}</Row>
          <Row label="E-mail">{cp.email ?? ''}</Row>
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
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (contactId: string) => counterpartiesApi.removeContact(workspaceId, cp.id, contactId),
    onSuccess: onChanged,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <>
      <Card span={7}>
        <CardHeader
          title="Контактные лица"
          subtitle="Подписант выбирается из них — на его номер уходит ссылка и SMS"
        />
        {cp.contacts.length === 0 ? (
          <EmptyState
            icon="people"
            title="Контактов пока нет"
            description="Без контактного лица документ некому отправить на подпись."
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
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {[c.position, c.phone, c.email].filter(Boolean).join(' · ') || '—'}
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
                          title: `Убрать «${c.name}»?`,
                          message: 'Контакт уйдёт в архив: в истории документов его имя останется.',
                          confirmLabel: 'Убрать',
                          danger: true,
                        },
                        async () => {
                          await remove.mutateAsync(c.id);
                        },
                      )
                    }
                  >
                    Убрать
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {isManager && (
        <Card span={5}>
          <CardHeader title="Добавить контакт" />
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            <Input label="Имя *" value={name} onChange={(e) => setName(e.target.value)} placeholder="Асель Нурланова" />
            <Input label="Должность" value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Директор" />
            <Input
              label="Телефон (для SMS со ссылкой)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 777 123 45 67"
            />
            <Input label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@company.kz" />
            <div>
              <Button icon="add" loading={add.isPending} disabled={!name.trim()} onClick={() => add.mutate()}>
                Добавить
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
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const setPrimary = useMutation({
    mutationFn: (accId: string) => counterpartiesApi.setPrimaryAccount(workspaceId, cp.id, accId),
    onSuccess: onChanged,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (accId: string) => counterpartiesApi.removeAccount(workspaceId, cp.id, accId),
    onSuccess: onChanged,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <>
      <Card span={7}>
        <CardHeader title="Банковские счета" subtitle="Основной подставляется в документы ({Контрагент.ИИК})" />
        {cp.bankAccounts.length === 0 ? (
          <EmptyState icon="card" title="Счетов пока нет" />
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
                  <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>{a.iban}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {a.bankName} · БИК {a.bik}
                  </div>
                </div>
                {a.isPrimary ? (
                  <Chip size="sm" tone="accent">
                    Основной
                  </Chip>
                ) : (
                  isManager && (
                    <Button variant="ghost" size="sm" loading={setPrimary.isPending} onClick={() => setPrimary.mutate(a.id)}>
                      Сделать основным
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
                        { title: 'Удалить счёт?', confirmLabel: 'Удалить', danger: true },
                        async () => {
                          await remove.mutateAsync(a.id);
                        },
                      )
                    }
                  >
                    Удалить
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {isManager && (
        <Card span={5}>
          <CardHeader title="Добавить счёт" subtitle="Первый счёт становится основным сам" />
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            <Input label="ИИК (IBAN) *" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="KZ86125KZT5004100100" />
            <Input label="Банк *" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="АО «Народный Банк»" />
            <Input label="БИК *" value={bik} onChange={(e) => setBik(e.target.value)} placeholder="HSBKKZKX" />
            <div>
              <Button
                icon="add"
                loading={add.isPending}
                disabled={!iban.trim() || !bankName.trim() || !bik.trim()}
                onClick={() => add.mutate()}
              >
                Добавить
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
        <CardHeader title="Хроника карточки" />
        {chronicleQuery.isPending ? (
          <LoadingBlock />
        ) : (
          <ChronicleFeed entries={entries as never[]} actors={actors} emptyText="Здесь появятся правки карточки и контактов" />
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

/** Дата → «15.01.2026» (так документ-основание пишется в шапке договора) */
const toDmy = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

/**
 * Разобрать сохранённое основание подписи обратно в поля формы: вид документа,
 * номер и дата хранятся ОДНОЙ строкой («Приказа № 12-к от 15.01.2026»), потому
 * что ровно в таком виде она печатается в договоре.
 */
function parseSignBasis(
  raw: string | null | undefined,
  isNew: boolean,
): { key: string; number: string; date: Date | null; custom: string } {
  const v = (raw ?? '').trim();
  if (!v) return { key: isNew ? 'ustav' : 'none', number: '', date: null, custom: '' };
  for (const o of SIGN_BASIS_OPTIONS) {
    if (o.value === 'custom') continue;
    if (v === o.label) return { key: o.value, number: '', date: null, custom: '' };
    if (o.needsDetail && v.startsWith(`${o.label} `)) {
      const rest = v.slice(o.label.length + 1).trim();
      const m = rest.match(/от\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/);
      if (m) {
        return {
          key: o.value,
          number: rest.slice(0, m.index).replace(/^№\s*/, '').trim(),
          date: new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])),
          custom: '',
        };
      }
      // Дата записана как попало (старая запись руками) — не мнём её разбором:
      // строка целиком уезжает в «Свой вариант» и остаётся под глазами человека
      if (/\bот\b/i.test(rest)) return { key: 'custom', number: '', date: null, custom: v };
      return { key: o.value, number: rest.replace(/^№\s*/, '').trim(), date: null, custom: '' };
    }
  }
  return { key: 'custom', number: '', date: null, custom: v };
}

/** Снять известную приставку полной формы («Товарищество … «Ромашка»» → «Ромашка») */
function stripLegalWrap(full: string): string {
  for (const w of Object.values(ORG_FORM_LEGAL_WRAP)) {
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
  const wrap = option.orgForm ? ORG_FORM_LEGAL_WRAP[option.orgForm] : null;

  const [name, setName] = useState(existing?.name ?? '');
  // Юрнаименование: человек вводит ТОЛЬКО название, полную приставку даёт вид
  const [legalBare, setLegalBare] = useState(() => (existing?.legalName ? stripLegalWrap(existing.legalName) : ''));
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
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [dupOf, setDupOf] = useState<string | null>(null);

  // Основание подписи — готовый список («…действующего на основании Устава»);
  // у документа-основания номер и дата спрашиваются РАЗДЕЛЬНО (дата — календарём)
  const parsedBasis = parseSignBasis(existing?.signBasis, !existing);
  const [basisKey, setBasisKey] = useState<string>(parsedBasis.key);
  const [basisNumber, setBasisNumber] = useState<string>(parsedBasis.number);
  const [basisDate, setBasisDate] = useState<Date | null>(parsedBasis.date);
  const [basisCustom, setBasisCustom] = useState<string>(parsedBasis.custom);
  const [basisTouched, setBasisTouched] = useState(!!existing);
  const basisOption = SIGN_BASIS_OPTIONS.find((o) => o.value === basisKey);
  const signBasisFull =
    basisKey === 'none'
      ? ''
      : basisKey === 'custom'
        ? basisCustom.trim()
        : basisOption
          ? [
              basisOption.label,
              basisOption.needsDetail && basisNumber.trim() ? `№ ${basisNumber.trim()}` : '',
              basisOption.needsDetail && basisDate ? `от ${toDmy(basisDate)}` : '',
            ]
              .filter(Boolean)
              .join(' ')
          : '';

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
        signBasis: signBasisFull || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
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
    onError: (e) => toastError(apiErrorMessage(e)),
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
      title={existing ? 'Карточка контрагента' : 'Новый контрагент'}
      subtitle="Реквизиты подставляются в договоры тегами {Контрагент.…}"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            icon="check"
            loading={save.isPending}
            disabled={!name.trim() || binInvalid}
            onClick={() => save.mutate()}
          >
            {existing ? 'Сохранить' : 'Добавить'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Select
          label="Вид"
          value={formKey}
          onChange={changeForm}
          options={COUNTERPARTY_FORM_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <Input
          label={kind === 'individual' ? 'ФИО *' : 'Название (рабочее имя) *'}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!legalTouched) setLegalBare(e.target.value);
          }}
          placeholder={kind === 'individual' ? 'Иванов Иван Иванович' : 'Ромашка'}
        />
        {kind !== 'individual' &&
          (wrap ? (
            // Вид стоит ПЕРЕД полем (как БИН/ИИН меняется от вида): ТОО «…», ИП …
            <Field
              label="Юридическое наименование"
              hint={legalFull ? `В договор пойдёт: ${legalFull}` : 'Полная форма вида добавится сама'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{option.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Input
                    aria-label={`Юридическое наименование (${option.label})`}
                    value={legalBare}
                    onChange={(e) => {
                      setLegalBare(e.target.value);
                      setLegalTouched(true);
                    }}
                    placeholder={formKey === 'ip' ? 'Иванов И. И.' : 'Ромашка'}
                  />
                </div>
              </div>
            </Field>
          ) : (
            <Input
              label="Юридическое наименование"
              value={legalBare}
              onChange={(e) => {
                setLegalBare(e.target.value);
                setLegalTouched(true);
              }}
              placeholder="Филиал АО «…» в г. Астане"
              hint="У этого вида наименование свободное — пишется целиком"
            />
          ))}
        <Input
          label={counterpartyIdLabel(kind)}
          value={bin}
          onChange={(e) => {
            setBin(e.target.value);
            setDupOf(null);
          }}
          onBlur={() => void checkDup(binTrimmed)}
          placeholder="123456789012"
          error={binInvalid ? 'Номер не проходит контрольную сумму (12 цифр)' : dupOf ? `Уже в справочнике: «${dupOf}»` : undefined}
        />
        <div style={twoCols}>
          <Input
            label="Юридический адрес"
            value={legalAddress}
            onChange={(e) => setLegalAddress(e.target.value)}
            placeholder="г. Астана, пр. Абая, 1"
          />
          <Input
            label="Фактический адрес"
            value={actualAddress}
            onChange={(e) => setActualAddress(e.target.value)}
            placeholder="Пусто — совпадает с юридическим"
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 'var(--spacing-3)' }}>
          <Input label="КБе" value={kbe} onChange={(e) => setKbe(e.target.value)} placeholder="17" />
          <Select
            label="Налоговый режим"
            value={taxRegime || null}
            onChange={(v) => setTaxRegime(v)}
            options={[{ value: '', label: 'Не указан' }, ...TAX_REGIMES.map((r) => ({ value: r.value, label: r.label }))]}
            placeholder="Не указан"
          />
        </div>
        <Toggle
          label="Плательщик НДС"
          description="Включите, если у контрагента есть свидетельство плательщика НДС — тогда суммы в договоре пишутся «в т. ч. НДС». Не уверены — уточните у контрагента."
          checked={vatPayer}
          onChange={setVatPayer}
        />
        {vatPayer && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--spacing-3)' }}>
            <Input label="Серия свидетельства" value={vatSeries} onChange={(e) => setVatSeries(e.target.value)} placeholder="60001" />
            <Input label="№ свидетельства" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="0031205" />
            <DatePicker label="Дата свидетельства" value={vatDate} onChange={(d) => setVatDate(d)} />
          </div>
        )}
        {kind !== 'individual' && (
          <Input
            label="Руководитель (ФИО)"
            value={directorName}
            onChange={(e) => setDirectorName(e.target.value)}
            placeholder="Иванов Иван"
          />
        )}
        <div style={twoCols}>
          <Select
            label="Основание подписи"
            hint={
              signBasisFull
                ? `В договор: «…действующего на основании ${signBasisFull}»`
                : 'На основании чего подписант вправе подписывать'
            }
            value={basisKey}
            onChange={(v) => {
              setBasisKey(v);
              setBasisTouched(true);
            }}
            options={[
              ...SIGN_BASIS_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
              { value: 'none', label: 'Не указано' },
            ]}
          />
          {basisOption?.needsDetail && basisKey !== 'custom' ? (
            <>
              <Input
                label="Номер"
                value={basisNumber}
                onChange={(e) => setBasisNumber(e.target.value)}
                placeholder={'numberPlaceholder' in basisOption ? basisOption.numberPlaceholder : ''}
              />
              {/* Дата — календарём, как «Дата свидетельства»: руками «от 15.01.2026» не набирают */}
              <DatePicker label="Дата" value={basisDate} onChange={(d) => setBasisDate(d)} />
            </>
          ) : basisKey === 'custom' ? (
            <Input
              label="Свой вариант"
              value={basisCustom}
              onChange={(e) => setBasisCustom(e.target.value)}
              placeholder="Решения учредителя № 1"
            />
          ) : (
            <div />
          )}
        </div>
        <div style={twoCols}>
          <Input label="Телефон" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 727 244 00 00" />
          <Input label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@company.kz" />
        </div>
        <Textarea label="Заметка" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
      </div>
    </Modal>
  );
}
