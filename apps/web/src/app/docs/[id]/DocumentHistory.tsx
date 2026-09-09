'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useConfirm } from '@/components/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentVersionDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { useBytes, useFormatters } from '@/lib/format';
import { getDownloadUrl } from '@/lib/files-api';
import { chronicleKey, documentVersionsKey, fetchChronicle } from '@/lib/queries';
import { listDocumentVersions, restoreDocumentVersion } from '@/lib/docs-api';
import type { DocsPlace } from '@/lib/docs-api';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';

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
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const f = useFormatters();
  const bytes = useBytes();
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
      a.download = `${t('versionFile', { title, n: version.versionNo })}.${title.split('.').pop() ?? ''}`;
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
        <div className="title-sm" style={{ flex: 1 }}>{t('history')}</div>
        <button
          type="button"
          onClick={onClose}
          title={t('hideHistory')}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.9rem' }}
        >
          ✕
        </button>
      </div>

      {error && <p className="body-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

      <section>
        <div className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>{t('versions')}</div>
        {versionsPending && <p className="body-sm">{tc('state.loading')}</p>}
        {!versionsPending && versions.length === 0 && (
          <p className="body-sm" style={{ color: 'var(--on-surface-variant)' }}>
            {t('noVersions')}
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
                  {t('versionNo', { n: v.versionNo })}
                  {v.signed && ` · ${t('versionSigned')}`}
                  {v.status === 'pending' && ` · ${t('versionPending')}`}
                </div>
                <div className="body-sm" style={{ fontSize: '0.72rem', color: 'var(--on-surface-variant)' }}>
                  {f.dateTime(v.createdAt, 'dayMonth')}
                  {v.size ? ` · ${bytes(v.size)}` : ''}
                  {v.reason === 'manual' ? ` · ${t('versionManual')}` : ''}
                </div>
              </div>
              {v.status === 'ready' && v.fileId && (
                <>
                  <button
                    type="button"
                    onClick={() => void download(v)}
                    title={t('downloadVersion')}
                    style={chipBtn(false)}
                  >
                    ↓
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => confirm(
                        {
                          title: t('restoreConfirm.title', { n: v.versionNo }),
                          message: t('restoreConfirm.message'),
                          confirmLabel: t('restore'),
                        },
                        () => restore.mutate(v.id),
                      )}
                      disabled={restore.isPending}
                      title={t('restoreHint')}
                      style={chipBtn(true)}
                    >
                      {restore.isPending ? '…' : `↩ ${t('restore')}`}
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>{t('edits')}</div>
        <ChronicleFeed
          entries={chronicle?.items ?? []}
          actors={chronicle?.actors ?? {}}
          emptyText={t('noEdits')}
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
