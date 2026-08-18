'use client';

// ============================================================
// «Отправить контрагенту» — модалка внешнего этапа.
//
// Одно окно: контрагент (если ещё не привязан) → подписант из его контактов →
// внутренние подписанты (по умолчанию — директор из реквизитов, иначе отправитель)
// → срок → SMS. Кнопка «Отправить» ждёт готовый PDF-отпечаток: контрагент увидит
// РОВНО его, и «Посмотреть, что уйдёт» открывает тот же файл.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DOC_EXTERNAL_DEFAULT_TTL_DAYS,
  DOC_SIGNATURE_LEVELS,
  type CounterpartyDto,
  type OrgDocumentDto,
  type WorkspaceRequisitesDto,
} from '@superapp/shared';
import { apiErrorMessage, apiGet } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { useAuthStore } from '@/lib/stores/auth';
import {
  counterpartiesKey,
  counterpartyKey,
  docTypesKey,
  orgDocumentKey,
  orgDocumentsPrefix,
} from '@/lib/queries';
import { Alert, Button, Chip, DatePicker, LoadingBlock, Modal, Select, Toggle } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { fetchCounterparties, fetchCounterparty } from '../counterparties/counterparties-api';
import { documentsApi, fetchDocTypes } from './documents-api';

export function SendToCounterpartyModal({
  workspaceId,
  doc,
  open,
  onClose,
  onSent,
}: {
  workspaceId: string;
  doc: OrgDocumentDto;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const qc = useQueryClient();
  const meId = useAuthStore((s) => s.user?.id ?? null);

  const [counterpartyId, setCounterpartyId] = useState<string | null>(doc.counterparty?.id ?? null);
  const [contactId, setContactId] = useState<string | null>(doc.counterpartyContact?.id ?? null);
  // Пикер показываем, если контрагента не было ПРИ ОТКРЫТИИ (снимок): привязка
  // теперь уходит на сервер сразу при выборе, и живи условие на doc.counterparty,
  // пикер исчезал бы из-под руки после первого же выбора — не давая передумать.
  const [showPicker] = useState(!doc.counterparty);
  const [signers, setSigners] = useState<Principal[]>([]);
  const [signersTouched, setSignersTouched] = useState(false);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [sendSms, setSendSms] = useState(true);

  // Отпечаток: контрагент подписывает РОВНО его. Пока не готов — кнопка ждёт.
  const subjectReady = doc.builderDoc ? !!doc.fileId : !!doc.pdfFileId;

  const typesQuery = useQuery({
    queryKey: docTypesKey(workspaceId),
    queryFn: () => fetchDocTypes(workspaceId),
    enabled: open,
  });
  const level = (typesQuery.data ?? []).find((t) => t.id === doc.docTypeId)?.signatureLevel ?? 'pep';
  const levelLabel = DOC_SIGNATURE_LEVELS.find((l) => l.value === level)?.label ?? level;

  const cpsQuery = useQuery({
    queryKey: counterpartiesKey(workspaceId, { forPicker: 'send' }),
    queryFn: () => fetchCounterparties(workspaceId, { limit: 200 }),
    enabled: open && showPicker,
  });
  const cpQuery = useQuery({
    queryKey: counterpartyKey(workspaceId, counterpartyId ?? ''),
    queryFn: () => fetchCounterparty(workspaceId, counterpartyId as string),
    enabled: open && !!counterpartyId,
  });
  const contacts = (cpQuery.data as CounterpartyDto | undefined)?.contacts ?? [];
  const contact = contacts.find((c) => c.id === contactId) ?? null;

  // Директор из реквизитов — подписант по умолчанию (без него — отправитель).
  const requisitesQuery = useQuery({
    queryKey: ['workspaces', workspaceId, 'requisites', 'send-modal'],
    queryFn: () => apiGet<WorkspaceRequisitesDto>(`/workspaces/${workspaceId}/requisites`),
    enabled: open,
    retry: false,
  });
  useEffect(() => {
    if (!open || signersTouched || signers.length > 0) return;
    const director = requisitesQuery.data?.directorUserId ?? null;
    const fallback = director ?? meId;
    if (fallback) setSigners([{ type: 'user', id: fallback }]);
  }, [open, requisitesQuery.data, meId, signersTouched, signers.length]);

  // Отпечаток мог ещё собираться (builder/docx): заказываем и поллим карточку
  useEffect(() => {
    if (!open || subjectReady) return;
    void documentsApi.requestPdf(workspaceId, doc.id).catch(() => undefined);
    const t = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: orgDocumentKey(workspaceId, doc.id) });
    }, 2500);
    return () => window.clearInterval(t);
  }, [open, subjectReady, workspaceId, doc.id, qc]);

  // Контрагент привязывается СРАЗУ при выборе (тем же PATCH, что и в карточке).
  // Раньше PATCH стоял первой строкой отправки — а он ставит пересборку бланка
  // (в тексте теги {Контрагент.*}), и sendExternal следующей строкой упирался в
  // собственный только что поставленный джоб: первая отправка договора с выбором
  // контрагента в модалке ловила отказ почти гарантированно. Теперь пересборка
  // идёт, пока человек выбирает подписанта и срок, а кнопка ждёт `rebuilding`.
  const bind = useMutation({
    mutationFn: (nextId: string | null) =>
      documentsApi.updateDocument(workspaceId, doc.id, { counterpartyId: nextId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orgDocumentKey(workspaceId, doc.id) });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const send = useMutation({
    mutationFn: () =>
      documentsApi.sendExternal(workspaceId, doc.id, {
        counterpartyContactId: contactId,
        internalSignerUserIds: signers.map((s) => s.id),
        ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
        sendSms: sendSms && !!contact?.phone,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orgDocumentKey(workspaceId, doc.id) });
      qc.invalidateQueries({ queryKey: orgDocumentsPrefix(workspaceId) });
      onClose();
      onSent();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const defaultDue = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + DOC_EXTERNAL_DEFAULT_TTL_DAYS);
    return d;
  }, []);

  const openSubjectPdf = async () => {
    try {
      if (doc.builderDoc && doc.fileId) {
        const res = await apiGet<{ url: string }>(`/files/${doc.fileId}/download`);
        window.open(res.url, '_blank', 'noopener');
        return;
      }
      if (!doc.pdfFileId) return;
      // У docx-документа PDF живёт ВАРИАНТОМ живого файла; у загруженного PDF —
      // сам файл (та же развилка, что у резолвера предмета на сервере).
      const variant = doc.documentId && doc.pdfFileId === doc.fileId ? 'pdf' : undefined;
      const res = await apiGet<{ url: string }>(`/files/${doc.pdfFileId}/download`, {
        params: variant ? { variant } : undefined,
      });
      window.open(res.url, '_blank', 'noopener');
    } catch (e) {
      toastError(apiErrorMessage(e));
    }
  };

  // Привязка доехала до сервера? Отправка шлёт только contactId — контрагент к
  // этому моменту обязан стоять на самой карточке (bind выше), иначе сервер
  // откажет «контакт не этого контрагента».
  const bound = counterpartyId === (doc.counterparty?.id ?? null);
  const canSend =
    !!counterpartyId &&
    !!contactId &&
    signers.length > 0 &&
    subjectReady &&
    level !== 'none' &&
    bound &&
    !bind.isPending &&
    !doc.rebuilding;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Отправить контрагенту"
      subtitle={doc.number ? `${doc.title} № ${doc.number}` : doc.title}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="ghost" icon="eye" disabled={!subjectReady} onClick={() => void openSubjectPdf()}>
            Посмотреть, что уйдёт
          </Button>
          <Button icon="send" loading={send.isPending} disabled={!canSend} onClick={() => send.mutate()}>
            Отправить
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {showPicker && (
          <Select
            label="Контрагент"
            value={counterpartyId}
            onChange={(v) => {
              const next = v || null;
              setCounterpartyId(next);
              setContactId(null);
              // Привязываем сразу: пересборка бланка с реквизитами контрагента
              // успевает дожеваться, пока выбирают подписанта и срок
              if (next) bind.mutate(next);
            }}
            options={(cpsQuery.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
            placeholder={(cpsQuery.data?.items ?? []).length === 0 ? 'Справочник пуст' : 'Выберите контрагента'}
          />
        )}

        {counterpartyId && cpQuery.isPending ? (
          <LoadingBlock />
        ) : counterpartyId && contacts.length === 0 ? (
          <Alert
            tone="warning"
            action={
              <Button
                variant="ghost"
                size="sm"
                icon="add"
                href={`/workspaces/${workspaceId}/counterparties?open=${counterpartyId}`}
              >
                Добавить контакт
              </Button>
            }
          >
            У контрагента нет контактных лиц — документ некому отправить на подпись
          </Alert>
        ) : counterpartyId ? (
          <Select
            label="Подписант со стороны контрагента"
            value={contactId}
            onChange={(v) => setContactId(v || null)}
            options={contacts.map((c) => ({
              value: c.id,
              label: [c.name, c.position, c.phone].filter(Boolean).join(' · '),
            }))}
            placeholder="Выберите контактное лицо"
            hint="Ему уйдёт ссылка на подписание; личность подтверждается SMS-кодом"
          />
        ) : null}

        <div>
          <span className="label-sm" style={{ fontWeight: 600, display: 'block', marginBottom: 'var(--spacing-2)' }}>
            Внутренние подписанты (с нашей стороны)
          </span>
          <EntitySelector
            types={['user']}
            value={signers}
            onChange={(v) => {
              setSignersTouched(true);
              setSigners(v);
            }}
            context={{ workspaceId }}
            placeholder="Кто подписывает от организации"
          />
        </div>

        <div style={{ display: 'flex', gap: 'var(--spacing-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DatePicker
            label="Срок подписания"
            value={expiresAt ?? defaultDue}
            min={new Date()}
            onChange={(d) => setExpiresAt(d)}
            width={190}
          />
          {/* Уровень диктует ВИД документа — здесь только показываем */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)', paddingBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Подпись:</span>
            <Chip size="sm" tone={level === 'ecp' ? 'accent' : 'neutral'} icon="signature">
              {levelLabel}
            </Chip>
          </span>
        </div>

        {contact?.phone && (
          <Toggle
            label={`Отправить SMS со ссылкой на ${contact.phone}`}
            checked={sendSms}
            onChange={setSendSms}
          />
        )}

        {!subjectReady && (
          <Alert tone="waiting">PDF-отпечаток ещё формируется — кнопка откроется, как только он будет готов</Alert>
        )}
        {subjectReady && !!doc.rebuilding && (
          <Alert tone="waiting">
            Пересобираем документ с данными контрагента — кнопка откроется через несколько секунд
          </Alert>
        )}
        {level === 'none' && (
          <Alert tone="danger">Вид документа не предполагает подписи — включите её в настройках вида</Alert>
        )}
        {!doc.number && (
          <Alert tone="warning">
            У документа нет номера. Отправить можно и так, но в тексте договора номер уже не появится —
            присвойте его на карточке до отправки.
          </Alert>
        )}
      </div>
    </Modal>
  );
}
