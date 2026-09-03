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
import { apiErrorMessage, apiGet } from '@/lib/api';
import { dmy } from '@/lib/dates';
import { toastError } from '@/lib/toast';
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
import { SignaturesBlock } from '@/components/sign/SignaturesBlock';
import { documentsApi, fetchOrgDocument } from '../documents-api';
import { FormFields } from '../SubmitDocumentModal';
import { SendToCounterpartyModal } from '../SendToCounterpartyModal';
import { ExternalStageBlock } from '../ExternalStageBlock';
import { ShareCardModal } from '@/app/messenger/ShareCardModal';
import { DocStatusChip } from '../documents-ui';
import { CampaignAckBanner, DeliveryBlock } from '../HrDocBlocks';

/** Значение поля читабельной строкой: период — «с … по … (N дней)», не [object Object] */
function readableFieldValue(value: unknown): string {
  if (isDocDateRangeValue(value)) {
    const dot = dmy;
    const days = docDateRangeDays(value);
    return value.from === value.to
      ? `${dot(value.from)} (1 день)`
      : `с ${dot(value.from)} по ${dot(value.to)} (дней: ${days})`;
  }
  return value === null || value === undefined ? '' : String(value);
}

export default function OrgDocumentPage() {
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
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () => documentsApi.cancel(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const withdraw = useMutation({
    mutationFn: () => documentsApi.withdraw(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const saveFields = useMutation({
    mutationFn: (fields: Record<string, unknown>) => documentsApi.updateDocument(id, documentId, { fields }),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const assignNumber = useMutation({
    mutationFn: () => documentsApi.assignNumber(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const returnToDraft = useMutation({
    mutationFn: () => documentsApi.returnToDraft(id, documentId),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
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
        <PageHeader breadcrumb="Документооборот" title="Документ не открылся" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title="Нет доступа к документу"
              description="Документ мог быть отменён, или его вид закрыт для вас."
              action={
                <Button variant="matte" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
                  К списку документов
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
        chip={<DocStatusChip status={doc.status} />}
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Button variant="ghost" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
              К списку
            </Button>
            <Button variant="ghost" icon="messenger" onClick={() => setShareOpen(true)}>
              В чат
            </Button>
            {doc.documentId && (
              <Button
                variant="matte"
                icon="edit"
                href={documentHref(doc.documentId, { refType: ORG_DOCUMENT_REF_TYPE, refId: doc.id }, { readonly: !can.edit })}
              >
                {can.edit ? 'Править документ' : 'Открыть документ'}
              </Button>
            )}
            {doc.builderDoc && can.edit && (
              <Button variant="matte" icon="edit" href={`/workspaces/${id}/documents/${doc.id}/edit`}>
                Править в конструкторе
              </Button>
            )}
            {can.submit && (
              <Button
                icon="check"
                loading={submit.isPending}
                // Пока фон пересобирает содержимое, сервер отправку отвергнет —
                // не предлагаем клик в гарантированный отказ (карточка опрашивается)
                disabled={!!doc.rebuilding}
                title={doc.rebuilding ? 'Документ пересобирается — несколько секунд' : undefined}
                onClick={() => submit.mutate()}
              >
                Отправить на маршрут
              </Button>
            )}
            {can.sendExternal && (
              <Button icon="send" onClick={() => setSendOpen(true)}>
                Отправить контрагенту
              </Button>
            )}
            {can.returnToDraft && (
              <Button
                variant="matte"
                icon="arrowLeft"
                loading={returnToDraft.isPending}
                onClick={() => returnToDraft.mutate()}
              >
                Вернуть в черновик
              </Button>
            )}
            {can.withdraw && (
              <Button
                variant="matte"
                icon="arrowLeft"
                loading={withdraw.isPending}
                onClick={() => withdraw.mutate()}
              >
                Вернуть в черновик
              </Button>
            )}
            {can.cancel && (
              <Button
                variant="ghost"
                icon="close"
                onClick={() =>
                  confirm(
                    {
                      title: 'Отменить документ?',
                      message: 'Он останется в реестре со статусом «Отменён» — история решений не пропадает.',
                      confirmLabel: 'Отменить документ',
                      danger: true,
                    },
                    async () => { await cancel.mutateAsync(); },
                  )
                }
              >
                Отменить
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
          <CardHeader title={doc.category === 'external' ? 'Данные документа' : 'Данные заявления'} />
          {/* Смотрим на ОБЪЯВЛЕНИЕ полей, а не на значения: поле, только что
              заведённое в конструкторе, ещё пустое — и по значениям карточка
              говорила «полей нет», то есть заполнить его было негде. */}
          {formFields.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>
              Заполняемых полей нет — документ собран по данным организации и сотрудника.
            </p>
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
                    Сохранить и пересобрать документ
                  </Button>
                </div>
              )}
            </div>
          ) : (
            /* Читаем по ОБЪЯВЛЕНИЮ: человеческая подпись поля вместо ключа-тега,
               и незаполненное поле видно прочерком, а не пропадает из списка */
            <dl style={{ display: 'grid', gap: 'var(--spacing-2)', margin: 0 }}>
              {formFields.map((f) => (
                <div key={f.key} style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                  <dt style={{ color: 'var(--text-muted)', minWidth: 160 }}>{f.label || f.key}</dt>
                  <dd style={{ margin: 0, fontWeight: 500 }}>
                    {readableFieldValue(fieldValues[f.key]) || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <Divider />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)', alignItems: 'center' }}>
            {doc.counterparty && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Контрагент:</span>
                <Chip size="sm" icon="workspace">
                  {doc.counterparty.name}
                </Chip>
                {doc.counterpartyContact && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    подписант: {doc.counterpartyContact.name}
                    {doc.counterpartyContact.position ? ` (${doc.counterpartyContact.position})` : ''}
                  </span>
                )}
              </span>
            )}
            {doc.subjectUserId && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  {doc.category === 'external' ? 'Куратор:' : 'Сторона:'}
                </span>
                <PersonChip size="M" userId={doc.subjectUserId} firstName={doc.subjectName ?? "Сотрудник"} />
              </span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Подал:</span>
              <PersonChip size="M" userId={doc.createdById} firstName={doc.createdByName ?? "Сотрудник"} />
            </span>
          </div>
        </Card>

        <Card span={5}>
          <CardHeader title="Состояние" />
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            <Row label="Вид">{doc.docTypeName}</Row>
            {doc.templateName && <Row label="Шаблон">{doc.templateName}</Row>}
            <Row label="Номер">
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
                    Присвоить номер
                  </Button>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>Не присвоен</span>
                )
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Присваивается при регистрации</span>
              )}
            </Row>
            <Row label="Подписан">
              {doc.signedAt ? new Date(doc.signedAt).toLocaleString('ru-RU') : <span style={{ color: 'var(--text-muted)' }}>—</span>}
            </Row>
            <Row label="Файл">
              {doc.fileId ? (
                <span style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                  <Button variant="ghost" size="sm" icon="download" onClick={() => downloadFile(doc.fileId!)}>
                    {/* Подпись — по НАСТОЯЩЕМУ формату: у блочного и ЗАГРУЖЕННОГО PDF
                        файл — сам PDF (у загруженного pdfFileId === fileId без
                        живого документа), «.docx» здесь было бы ложью */}
                    {doc.builderDoc || (doc.pdfFileId === doc.fileId && !doc.documentId)
                      ? 'Скачать PDF'
                      : 'Скачать .docx'}
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
                      PDF-отпечаток
                    </Button>
                  )}
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Формируется…</span>
              )}
            </Row>
            {doc.approvalRequestId && (
              <Row label="Решение">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="checkCircle"
                  href={approvalHref(doc.approvalRequestId, id)}
                >
                  Маршрут согласования
                </Button>
              </Row>
            )}
            {doc.parentDocumentId && (
              <Row label="Основание">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="arrowRight"
                  onClick={() => router.push(`/workspaces/${id}/documents/${doc.parentDocumentId}`)}
                >
                  Открыть документ-основание
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
          <CardHeader title="Хроника документа" />
          {chronicleQuery.isPending ? (
            <LoadingBlock />
          ) : (
            <ChronicleFeed
              entries={entries as never[]}
              actors={actors}
              emptyText="Здесь появятся отправка, решения, номер и подшивка"
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
    toastError(apiErrorMessage(e));
  }
}
