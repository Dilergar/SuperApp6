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

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ORG_DOCUMENT_REF_TYPE,
  approvalHref,
  type ChatterActorLite,
  type ChatterPageDto,
} from '@superapp/shared';
import { apiErrorMessage, apiGet } from '@/lib/api';
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
import { documentsApi, fetchOrgDocument } from '../documents-api';
import { DocStatusChip } from '../documents-ui';

export default function OrgDocumentPage() {
  const { id, documentId } = useParams<{ id: string; documentId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  const docQuery = useQuery({
    queryKey: orgDocumentKey(id, documentId),
    queryFn: () => fetchOrgDocument(id, documentId),
  });
  const doc = docQuery.data;

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
    mutationFn: (fields: Record<string, string>) => documentsApi.updateDocument(id, documentId, { fields }),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const fieldValues = useMemo(
    () => draft ?? (Object.fromEntries(Object.entries(doc?.fields ?? {}).map(([k, v]) => [k, String(v ?? '')])) as Record<string, string>),
    [draft, doc?.fields],
  );

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
        <PageHeader breadcrumb="Документы" title="Документ не открылся" />
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
            {doc.documentId && (
              <Button
                variant="matte"
                icon="edit"
                href={documentHref(doc.documentId, { refType: ORG_DOCUMENT_REF_TYPE, refId: doc.id }, { readonly: !can.edit })}
              >
                {can.edit ? 'Править документ' : 'Открыть документ'}
              </Button>
            )}
            {can.submit && (
              <Button icon="check" loading={submit.isPending} onClick={() => submit.mutate()}>
                Отправить на маршрут
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

      <BentoGrid>
        <Card span={7}>
          <CardHeader title="Данные заявления" />
          {Object.keys(fieldValues).length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>
              Заполняемых полей нет — документ собран по данным организации и сотрудника.
            </p>
          ) : can.edit ? (
            // Пока документ правится, значения формы — настоящие поля: исправил дату,
            // сохранил, и .docx пересобирается тем же путём, что при подаче.
            <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
              {Object.keys(fieldValues).map((key) => (
                <Input
                  key={key}
                  label={key}
                  value={fieldValues[key] ?? ''}
                  onChange={(e) => setDraft({ ...fieldValues, [key]: e.target.value })}
                />
              ))}
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
            <dl style={{ display: 'grid', gap: 'var(--spacing-2)', margin: 0 }}>
              {Object.entries(fieldValues).map(([key, value]) => (
                <div key={key} style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                  <dt style={{ color: 'var(--text-muted)', minWidth: 160 }}>{key}</dt>
                  <dd style={{ margin: 0, fontWeight: 500 }}>{value || '—'}</dd>
                </div>
              ))}
            </dl>
          )}

          <Divider />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)', alignItems: 'center' }}>
            {doc.subjectUserId && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Сторона:</span>
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
                    Скачать .docx
                  </Button>
                  {/* PDF — это ОТПЕЧАТОК на момент отправки: именно его видит решающий
                      и именно его подпишет core/sign. Снимался он и раньше, но на
                      карточке не показывался вовсе — скачать его было нечем. */}
                  {doc.pdfFileId && (
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
