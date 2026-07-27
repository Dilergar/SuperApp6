'use client';

import { useState } from 'react';
import { useConfirm } from '@/components/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentVersionDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { getDownloadUrl } from '@/lib/files-api';
import { chronicleKey, documentVersionsKey, fetchChronicle } from '@/lib/queries';
import { listDocumentVersions, restoreDocumentVersion } from '@/lib/docs-api';
import type { DocsPlace } from '@/lib/docs-api';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function humanSize(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.max(Math.round(bytes / 1024), 1)} КБ`;
}

/**
 * Панель «История» документа: снимки-версии (скачать / вернуть) и лента правок.
 *
 * Лента живёт в хронике САМОГО документа (core/chatter, refType='document') — поэтому
 * она есть и у файла, который не лежит ни в задаче, ни в чате: для него это единственное
 * место, где видно, кто когда что делал.
 */
export function DocumentHistory({
  documentId,
  title,
  place,
  canEdit,
  onClose,
  onSuspendEditor,
  onResumeEditor,
}: {
  documentId: string;
  title: string;
  place: DocsPlace | null;
  canEdit: boolean;
  onClose: () => void;
  /** Погасить редактор (он отпустит документ) — перед подменой содержимого */
  onSuspendEditor: () => void;
  /** Открыть заново — уже с новым содержимым */
  onResumeEditor: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmUI] = useConfirm();

  const { data: versions = [], isPending: versionsPending } = useQuery({
    queryKey: documentVersionsKey(documentId),
    queryFn: () => listDocumentVersions(documentId, place),
    retry: false,
    // Снимок режет фоновый джоб — секунду-другую версия числится «готовится».
    // Без опроса она так и осталась бы «готовящейся» до перезагрузки страницы,
    // хотя файл давно на месте.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((v) => v.status === 'pending') ? 2000 : false,
  });

  const { data: chronicle } = useQuery({
    queryKey: chronicleKey('document', documentId),
    queryFn: () => fetchChronicle('document', documentId),
    retry: false,
  });

  const download = async (version: DocumentVersionDto) => {
    if (!version.fileId) return;
    try {
      const { url } = await getDownloadUrl(version.fileId);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title} (версия ${version.versionNo}).${title.split('.').pop() ?? ''}`;
      a.rel = 'noopener';
      a.click();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  /**
   * Возврат версии из открытого документа. Подменять байты под работающим редактором
   * нельзя — сервер такой запрос отклоняет, и это правильно: у редактора своё состояние
   * в памяти, и подмена обернулась бы конфликтом или потерей правок. Поэтому здесь
   * честная последовательность: гасим редактор → ждём, пока он отпустит документ
   * (Unlock приходит через секунду-другую после закрытия) → подменяем → открываем заново.
   */
  const restore = useMutation({
    mutationFn: async (versionId: string) => {
      onSuspendEditor();
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await restoreDocumentVersion(documentId, versionId, place);
          return;
        } catch (err) {
          const busy = (err as { response?: { status?: number } })?.response?.status === 409;
          if (!busy || Date.now() > deadline) throw err;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: documentVersionsKey(documentId) });
      void qc.invalidateQueries({ queryKey: chronicleKey('document', documentId) });
      onResumeEditor();
    },
    onError: (err) => {
      setError(apiErrorMessage(err));
      onResumeEditor();
    },
  });

  return (
    <aside
      style={{
        width: 'min(380px, 100%)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--spacing-4)',
        padding: 'var(--spacing-4)',
        background: 'var(--surface-container)',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
        <div className="title-sm" style={{ flex: 1 }}>История</div>
        <button
          type="button"
          onClick={onClose}
          title="Скрыть историю"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.9rem' }}
        >
          ✕
        </button>
      </div>

      {error && <p className="body-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

      <section>
        <div className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>Версии</div>
        {versionsPending && <p className="body-sm">Загрузка…</p>}
        {!versionsPending && versions.length === 0 && (
          <p className="body-sm" style={{ color: 'var(--on-surface-variant)' }}>
            Пока нет ни одной — версия создаётся, когда из документа выходит последний редактор.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {versions.map((v) => (
            <div
              key={v.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-2)',
                padding: '0.5rem 0.6rem',
                background: 'var(--surface)',
                borderRadius: 'var(--radius-sketch)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="label-md" style={{ fontSize: '0.82rem' }}>
                  Версия {v.versionNo}
                  {v.signed && ' · подписана'}
                  {v.status === 'pending' && ' · готовится'}
                </div>
                <div className="body-sm" style={{ fontSize: '0.72rem', color: 'var(--on-surface-variant)' }}>
                  {dateFmt.format(new Date(v.createdAt))}
                  {v.size ? ` · ${humanSize(v.size)}` : ''}
                  {v.reason === 'manual' ? ' · вручную' : ''}
                </div>
              </div>
              {v.status === 'ready' && v.fileId && (
                <>
                  <button
                    type="button"
                    onClick={() => void download(v)}
                    title="Скачать эту версию"
                    style={chipBtn(false)}
                  >
                    ↓
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => confirm(
                        {
                          title: `Вернуть версию ${v.versionNo} как текущую?`,
                          message: 'Редактор закроется и откроется заново. Нынешнее содержимое останется в истории — возврат можно отменить.',
                          confirmLabel: 'Вернуть',
                        },
                        () => restore.mutate(v.id),
                      )}
                      disabled={restore.isPending}
                      title="Сделать эту версию текущим содержимым"
                      style={chipBtn(true)}
                    >
                      {restore.isPending ? '…' : '↩ Вернуть'}
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>Правки</div>
        <ChronicleFeed
          entries={chronicle?.items ?? []}
          actors={chronicle?.actors ?? {}}
          emptyText="Пока никто не правил"
        />
      </section>
      {confirmUI}
    </aside>
  );
}

function chipBtn(accent: boolean): React.CSSProperties {
  return {
    border: 'none',
    background: accent
      ? 'color-mix(in srgb, var(--success) 14%, transparent)'
      : 'var(--surface-container-high)',
    color: accent ? 'var(--success)' : 'var(--on-surface)',
    borderRadius: 'var(--radius-sketch)',
    padding: '0.25rem 0.5rem',
    fontSize: '0.72rem',
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  };
}
