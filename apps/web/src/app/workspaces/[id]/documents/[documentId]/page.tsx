'use client';

// ============================================================
// Карточка документа организации.
//
// Здесь человек делает ровно три вещи: смотрит, что получилось, правит, пока
// можно, и отправляет на маршрут. Всё остальное на странице — доказательства:
// номер, стороны, отпечаток и хроника «кто и когда».
//
// Кнопки рисуются по `can`, который считает СЕРВЕР: клиент не должен
// пересобирать правила «кому что можно» второй раз — они разъедутся.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ORG_DOCUMENT_REF_TYPE,
  approvalHref,
  docDateRangeDays,
  isDocDateRangeValue,
  type ChatterActorLite,
  type ChatterPageDto,
  type DocFormFieldDto,
} from '@superapp/shared';
import { apiGet } from '@/lib/api';
import { dmy } from '@/lib/dates';
import { useFormatters } from '@/lib/format';

import { documentHref } from '@/lib/docs-api';
import { approvalsRootKey, orgDocumentKey, orgDocumentsPrefix } from '@/lib/queries';
import {
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  Divider,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  useConfirm,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { NotesPanel } from '@/components/notes/NotesPanel';
import { SignaturesBlock } from '@/components/sign/SignaturesBlock';
import { documentsApi, fetchOrgDocument } from '../documents-api';
import { FormFields } from '../SubmitDocumentModal';
import { SendToCounterpartyModal } from '../SendToCounterpartyModal';
import { ExternalStageBlock } from '../ExternalStageBlock';
import { ShareCardModal } from '@/app/messenger/ShareCardModal';
import { DocStatusChip } from '../documents-ui';
import { HeldChip } from '@/components/lifecycle/HeldChip';
import { CampaignAckBanner, DeliveryBlock } from '../HrDocBlocks';

import { toastApiError } from '@/lib/api-errors';
/**
 * Значение поля читабельной строкой: период — «с … по … (N дней)», не [object Object].
 * Слова приходят параметром: функция чистая, каталога у неё нет.
 */
function readableFieldValue(value: unknown, tr: (key: string, values?: Record<string, string | number>) => string): string {
  if (isDocDateRangeValue(value)) {
    if (value.from === value.to) return tr('card.rangeOneDay', { date: dmy(value.from) });
    return tr('card.rangeSpan', {
      from: dmy(value.from),
      to: dmy(value.to),
      days: docDateRangeDays(value),
    });
  }
  return value === null || value === undefined ? '' : String(value);
}

export default function OrgDocumentPage() {
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const tn = useTranslations('notes');
  const f = useFormatters();
  const { id, documentId } = useParams<{ id: string; documentId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  const docQuery = useQuery({
    queryKey: orgDocumentKey(id, documentId),
    queryFn: () => fetchOrgDocument(id, documentId),
    // Пересборка содержимого (правка полей/контрагента, номер) живёт секунды —
    // опрашиваем карточку, пока флаг не погаснет: кнопки отправки в это время
    // погашены, и без опроса они не ожили бы до ручного F5.
    refetchInterval: (q) => (q.state.data?.rebuilding ? 2500 : false),
  });
  const doc = docQuery.data;

  // Документ живёт в ДРУГОЙ организации, чем говорит адрес: права сервер считает
  // по строке документа, а каркас выводит контекст «Личное / Организация» РОВНО
  // из пути — по чужому адресу договор организации Б рисовался внутри сайдбара
  // и счётчиков организации А. Переадресуем на родной адрес (прецедент — рабочая
  // заявка согласований, открытая по личному пути).
  useEffect(() => {
    if (doc && doc.workspaceId !== id) {
      router.replace(`/workspaces/${doc.workspaceId}/documents/${doc.id}`);
    }
  }, [doc, id, router]);

  const chronicleQuery = useInfiniteQuery({
    queryKey: ['chatter', ORG_DOCUMENT_REF_TYPE, documentId],
    queryFn: async ({ pageParam }) => {
      // Был `items: unknown[]` при готовом shared-типе рядом: записи хроники уезжали
      // в ChronicleFeed вообще непроверенными.
      return apiGet<ChatterPageDto>(`/chatter/${ORG_DOCUMENT_REF_TYPE}/${documentId}`, {
        params: { cursor: (pageParam as string | undefined) || undefined },
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!doc,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: orgDocumentKey(id, documentId) });
    // ПРЕФИКС, а не `orgDocumentsKey(id)`: тот ключ несёт ещё и сериализованные
    // фильтры, поэтому совпадал только со списком без фильтров. Вкладки «Мои
    // документы» и «Заявления» (в их ключе есть userId) после отправки оставались
    // со старым статусом — глобальный staleTime 60 с их не перезапрашивал.
    qc.invalidateQueries({ queryKey: orgDocumentsPrefix(id) });
    qc.invalidateQueries({ queryKey: ['chatter', ORG_DOCUMENT_REF_TYPE, documentId] });
    // Решения по документу живут в общей стопке — её счётчик тоже мог измениться.
    qc.invalidateQueries({ queryKey: approvalsRootKey });
  };

  const submit = useMutation({
    mutationFn: () => documentsApi.submit(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const cancel = useMutation({
    mutationFn: () => documentsApi.cancel(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const withdraw = useMutation({
    mutationFn: () => documentsApi.withdraw(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const saveFields = useMutation({
    mutationFn: (fields: Record<string, unknown>) => documentsApi.updateDocument(id, documentId, { fields }),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const assignNumber = useMutation({
    mutationFn: () => documentsApi.assignNumber(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const returnToDraft = useMutation({
    mutationFn: () => documentsApi.returnToDraft(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const [sendOpen, setSendOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const fieldValues = useMemo(() => draft ?? (doc?.fields ?? {}), [draft, doc?.fields]);
  // Объявление формы — из шаблона; у старых документов без него поля собираются
  // по ключам значений (период узнаётся по форме значения)
  const formFields = useMemo<DocFormFieldDto[]>(() => {
    if (doc?.formFields?.length) return doc.formFields;
    return Object.keys(doc?.fields ?? {}).map((key) => ({
      key,
      label: key,
      kind: isDocDateRangeValue((doc?.fields ?? {})[key]) ? 'daterange' : 'text',
    }));
  }, [doc?.formFields, doc?.fields]);

  const entries = useMemo(
    () => (chronicleQuery.data?.pages ?? []).flatMap((p) => p.items),
    [chronicleQuery.data],
  );
  const actors = useMemo(() => {
    const merged: Record<string, ChatterActorLite> = {};
    for (const p of chronicleQuery.data?.pages ?? []) Object.assign(merged, p.actors);
    return merged;
  }, [chronicleQuery.data]);

  if (docQuery.isPending) return <LoadingBlock />;

  if (docQuery.isError || !doc) {
    return (
      <>
        <PageHeader breadcrumb={tr('page.title')} title={tr('card.failedTitle')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title={tr('card.noAccessTitle')}
              description={tr('card.noAccessText')}
              action={
                <Button variant="matte" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
                  {tr('card.toList')}
                </Button>
              }
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const can = doc.can ?? { edit: false, submit: false, cancel: false, withdraw: false, manage: false };

  return (
    <>
      <PageHeader
        breadcrumb={doc.docTypeName}
        title={doc.number ? `${doc.title} № ${doc.number}` : doc.title}
        chip={
          <span style={{ display: 'inline-flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <DocStatusChip status={doc.status} />
            {/* Заморозка документа — видит руководитель и выше (решает сервер); ведущему документ — запрос */}
            {can.manage && <HeldChip workspaceId={doc.workspaceId} type="OrgDocument" id={doc.id} />}
          </span>
        }
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Button variant="ghost" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
              {tr('card.back')}
            </Button>
            <Button variant="ghost" icon="messenger" onClick={() => setShareOpen(true)}>
              {tr('card.toChat')}
            </Button>
            {doc.documentId && (
              <Button
                variant="matte"
                icon="edit"
                href={documentHref(doc.documentId, { refType: ORG_DOCUMENT_REF_TYPE, refId: doc.id }, { readonly: !can.edit })}
              >
                {tr(can.edit ? 'card.editDocument' : 'card.openDocument')}
              </Button>
            )}
            {doc.builderDoc && can.edit && (
              <Button variant="matte" icon="edit" href={`/workspaces/${id}/documents/${doc.id}/edit`}>
                {tr('card.editInBuilder')}
              </Button>
            )}
            {can.submit && (
              <Button
                icon="check"
                loading={submit.isPending}
                // Пока фон пересобирает содержимое, сервер отправку отвергнет —
                // не предлагаем клик в гарантированный отказ (карточка опрашивается)
                disabled={!!doc.rebuilding}
                title={doc.rebuilding ? tr('card.rebuildingHint') : undefined}
                onClick={() => submit.mutate()}
              >
                {tr('card.submitToRoute')}
              </Button>
            )}
            {can.sendExternal && (
              <Button icon="send" onClick={() => setSendOpen(true)}>
                {tr('send.title')}
              </Button>
            )}
            {can.returnToDraft && (
              <Button
                variant="matte"
                icon="arrowLeft"
                loading={returnToDraft.isPending}
                onClick={() => returnToDraft.mutate()}
              >
                {tr('card.returnToDraft')}
              </Button>
            )}
            {can.withdraw && (
              <Button
                variant="matte"
                icon="arrowLeft"
                loading={withdraw.isPending}
                onClick={() => withdraw.mutate()}
              >
                {tr('card.returnToDraft')}
              </Button>
            )}
            {can.cancel && (
              <Button
                variant="ghost"
                icon="close"
                onClick={() =>
                  confirm(
                    {
                      title: tr('card.cancelTitle'),
                      message: tr('card.cancelText'),
                      confirmLabel: tr('card.cancelConfirm'),
                      danger: true,
                    },
                    async () => { await cancel.mutateAsync(); },
                  )
                }
              >
                {tc('actions.cancel')}
              </Button>
            )}
          </div>
        }
      />

      {/* КЭДО: задание кампании ознакомления адресату — прямо на карточке */}
      <CampaignAckBanner workspaceId={id} documentId={doc.id} />

      <BentoGrid>
        {/* КЭДО: специальный режим вручения (виды со specialDelivery) */}
        <DeliveryBlock workspaceId={id} doc={doc} />
        <Card span={7}>
          {/* Заголовок — по категории: у договора «заявление» звучало бы ложью */}
          <CardHeader title={tr(doc.category === 'external' ? 'card.dataDocument' : 'card.dataApplication')} />
          {/* Смотрим на ОБЪЯВЛЕНИЕ полей, а не на значения: поле, только что
              заведённое в конструкторе, ещё пустое — и по значениям карточка
              говорила «полей нет», то есть заполнить его было негде. */}
          {formFields.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>{tr('card.noFields')}</p>
          ) : can.edit ? (
            // Пока документ правится, значения формы — настоящие поля ТЕМИ ЖЕ
            // контролами, что при подаче (даты — мини-календарь, период — пара):
            // исправил, сохранил — и документ пересобирается тем же путём.
            <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
              <FormFields fields={formFields} values={fieldValues} onChange={setDraft} />
              {draft && (
                <div>
                  <Button
                    variant="matte"
                    icon="check"
                    loading={saveFields.isPending}
                    onClick={() => saveFields.mutate(draft)}
                  >
                    {tr('card.saveAndRebuild')}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            /* Читаем по ОБЪЯВЛЕНИЮ: человеческая подпись поля вместо ключа-тега,
               и незаполненное поле видно прочерком, а не пропадает из списка */
            <dl style={{ display: 'grid', gap: 'var(--spacing-2)', margin: 0 }}>
              {formFields.map((field) => (
                <div key={field.key} style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                  <dt style={{ color: 'var(--text-muted)', minWidth: 160 }}>{field.label || field.key}</dt>
                  <dd style={{ margin: 0, fontWeight: 500 }}>
                    {readableFieldValue(fieldValues[field.key], tr) || tc('labels.dash')}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <Divider />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)', alignItems: 'center' }}>
            {doc.counterparty && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ color: 'var(--text-muted)' }}>{tr('card.counterpartyRow')}</span>
                <Chip size="sm" icon="workspace">
                  {doc.counterparty.name}
                </Chip>
                {doc.counterpartyContact && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    {tr('card.signerIs', { name: doc.counterpartyContact.name })}
                    {doc.counterpartyContact.position ? ` (${doc.counterpartyContact.position})` : ''}
                  </span>
                )}
              </span>
            )}
            {doc.subjectUserId && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  {tr(doc.category === 'external' ? 'card.curatorRow' : 'card.partyRow')}
                </span>
                <PersonChip size="M" userId={doc.subjectUserId} firstName={doc.subjectName ?? tc('labels.someone')} />
              </span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <span style={{ color: 'var(--text-muted)' }}>{tr('card.submittedBy')}</span>
              <PersonChip size="M" userId={doc.createdById} firstName={doc.createdByName ?? tc('labels.someone')} />
            </span>
          </div>
        </Card>

        <Card span={5}>
          <CardHeader title={tr('card.state')} />
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            <Row label={tr('card.typeRow')}>{doc.docTypeName}</Row>
            {doc.templateName && <Row label={tr('card.templateRow')}>{doc.templateName}</Row>}
            <Row label={tr('card.numberRow')}>
              {doc.number ? (
                <Chip size="sm" icon="list">
                  {doc.number}
                </Chip>
              ) : doc.category === 'external' ? (
                // Внешний контур: номер печатается в тексте ДО отправки — ghost-кнопка
                // прямо в ряду (это не главное действие шапки)
                doc.can?.assignNumber ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="add"
                    loading={assignNumber.isPending}
                    onClick={() => assignNumber.mutate()}
                  >
                    {tr('card.assignNumber')}
                  </Button>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>{tr('card.numberNone')}</span>
                )
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{tr('card.numberOnRegister')}</span>
              )}
            </Row>
            <Row label={tr('card.signedAtRow')}>
              {doc.signedAt ? (
                f.dateTime(doc.signedAt)
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{tc('labels.dash')}</span>
              )}
            </Row>
            <Row label={tr('card.fileRow')}>
              {doc.fileId ? (
                <span style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                  <Button variant="ghost" size="sm" icon="download" onClick={() => downloadFile(doc.fileId!)}>
                    {/* Подпись — по НАСТОЯЩЕМУ формату: у блочного и ЗАГРУЖЕННОГО PDF
                        файл — сам PDF (у загруженного pdfFileId === fileId без
                        живого документа), «.docx» здесь было бы ложью */}
                    {doc.builderDoc || (doc.pdfFileId === doc.fileId && !doc.documentId)
                      ? tr('card.downloadPdf')
                      : tr('card.downloadDocx')}
                  </Button>
                  {/* PDF — это ОТПЕЧАТОК на момент отправки: именно его видит решающий
                      и именно его подпишет core/sign. Снимался он и раньше, но на
                      карточке не показывался вовсе — скачать его было нечем. */}
                  {doc.pdfFileId && doc.pdfFileId !== doc.fileId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="file"
                      onClick={() => downloadFile(doc.pdfFileId!, 'pdf')}
                    >
                      {tr('card.pdfImprint')}
                    </Button>
                  )}
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{tr('card.fileBuilding')}</span>
              )}
            </Row>
            {doc.approvalRequestId && (
              <Row label={tr('card.decisionRow')}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="checkCircle"
                  href={approvalHref(doc.approvalRequestId, id)}
                >
                  {tr('card.approvalRoute')}
                </Button>
              </Row>
            )}
            {doc.parentDocumentId && (
              <Row label={tr('card.groundRow')}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="arrowRight"
                  onClick={() => router.push(`/workspaces/${id}/documents/${doc.parentDocumentId}`)}
                >
                  {tr('card.openGround')}
                </Button>
              </Row>
            )}
          </div>
        </Card>

        {/* Внешний этап (категория «С контрагентами»): статус доставки, ссылка,
            SMS и стороны. Подписи НЕ дублируются — они ниже, в блоке «Подписи». */}
        {doc.external && (
          <ExternalStageBlock workspaceId={id} doc={doc} external={doc.external} onChanged={refresh} />
        )}

        {/* Электронные подписи под документом: кто, чем и когда, плюс кнопка
            «Подписать» тому, кого ждут, и артефакты (протокол, экспортный пакет). */}
        {doc.sign && (
          <div style={{ gridColumn: 'span 12' }}>
            <SignaturesBlock
              sign={doc.sign}
              onChanged={() => {
                void qc.invalidateQueries({ queryKey: ['workspaces', id, 'documents'] });
              }}
            />
          </div>
        )}

        <Card span={12}>
          <CardHeader title={tn('breadcrumb')} subtitle={tr('card.notesSubtitle')} />
          <NotesPanel target={{ type: 'document', id: documentId }} scope={{ workspaceId: id }} />
        </Card>

        <Card span={12}>
          <CardHeader title={tr('card.chronicle')} />
          {chronicleQuery.isPending ? (
            <LoadingBlock />
          ) : (
            <ChronicleFeed
              entries={entries as never[]}
              actors={actors}
              emptyText={tr('card.chronicleEmpty')}
            />
          )}
        </Card>
      </BentoGrid>

      <SendToCounterpartyModal
        workspaceId={id}
        doc={doc}
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        onSent={refresh}
      />
      {/* Документ пересылается в чат живой карточкой (Принцип 3) */}
      {shareOpen && (
        <ShareCardModal
          refType={ORG_DOCUMENT_REF_TYPE}
          refId={doc.id}
          title={doc.title}
          onClose={() => setShareOpen(false)}
        />
      )}
      {confirmUI}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center' }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 110 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Ссылка на байты живёт минуты — запрашиваем её в момент клика, а не заранее.
 * `variant` — производная того же файла (PDF-отпечаток документа лежит вариантом).
 */
async function downloadFile(fileId: string, variant?: string) {
  try {
    const res = await apiGet<{ url: string }>(`/files/${fileId}/download`, {
      params: variant ? { variant } : undefined,
    });
    window.open(res.url, '_blank', 'noopener');
  } catch (e) {
    toastApiError(e);
  }
}
