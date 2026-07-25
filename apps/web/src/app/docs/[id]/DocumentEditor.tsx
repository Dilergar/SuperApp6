'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentOpenDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage } from '@/lib/api';
import { documentKey, documentVersionsKey } from '@/lib/queries';
import { getDocument, openDocument, saveDocumentVersion } from '@/lib/docs-api';

const FRAME_NAME = 'sa6-docs-frame';

/**
 * Страница документа: наш заголовок + полноэкранный редактор в iframe.
 *
 * Два моста наружу:
 *  1) form POST — токен уходит в ТЕЛЕ запроса, а не в URL. В URL он осел бы в истории
 *     браузера и утёк бы в Referer сторонним ресурсам страницы редактора.
 *  2) postMessage — канал хоста: рукопожатие Host_PostmessageReady, «документ изменён»,
 *     «пользователь закрыл». Сюда же встанет будущая кнопка «Подписать ЭЦП».
 */
export default function DocumentEditor() {
  const { isReady } = useRequireAuth();
  const authLoading = !isReady;
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();

  const documentId = params?.id as string;
  const refType = search.get('refType') ?? undefined;
  const refId = search.get('refId') ?? undefined;
  const place = useMemo(
    () => (refType && refId ? { refType, refId } : null),
    [refType, refId],
  );

  // Режим — состояние страницы, а не только адрес: из просмотра можно ОСОЗНАННО
  // перейти в правку кнопкой, не возвращаясь к вложению.
  const [readonly, setReadonly] = useState(search.get('readonly') === '1');

  const formRef = useRef<HTMLFormElement>(null);
  const [session, setSession] = useState<DocumentOpenDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const { data: doc } = useQuery({
    queryKey: documentKey(documentId),
    queryFn: () => getDocument(documentId, place),
    enabled: !authLoading && !!documentId,
    retry: false,
  });

  /** Открыть/переоткрыть сессию редактора (первый вход и продление токена) */
  const start = useCallback(async () => {
    try {
      const opened = await openDocument(documentId, { refType, refId, readonly });
      setSession(opened);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [documentId, refType, refId, readonly]);

  useEffect(() => {
    if (!authLoading && documentId) void start();
  }, [authLoading, documentId, start]);

  // Форма шлётся ПОСЛЕ появления session (и заново — при продлении токена): iframe
  // навигируется POST-запросом, поэтому один и тот же фрейм переиспользуется.
  useEffect(() => {
    if (session) formRef.current?.submit();
  }, [session]);

  /**
   * Долгая правка не должна упираться в срок токена: за DOCS_LIMITS.tokenRefreshLeadMin
   * до конца молча берём свежий и перепощиваем форму. Для человека это невидимо.
   */
  useEffect(() => {
    if (!session?.refreshAt) return;
    const delay = new Date(session.refreshAt).getTime() - Date.now();
    const timer = setTimeout(() => void start(), Math.max(delay, 60_000));
    return () => clearTimeout(timer);
  }, [session?.refreshAt, start]);

  const editorOrigin = useMemo(() => {
    if (!session?.editorUrl) return null;
    try {
      return new URL(session.editorUrl).origin;
    } catch {
      return null;
    }
  }, [session?.editorUrl]);

  /**
   * Документ открывается в ОТДЕЛЬНОЙ вкладке, и «назад» в ней вести некуда — такую
   * вкладку закрываем. Если же на страницу пришли по прямой ссылке (история есть),
   * ведём себя обычно: шаг назад.
   */
  const closeDocument = useCallback(() => {
    if (window.history.length > 1) router.back();
    else window.close();
  }, [router]);

  // postMessage-мост
  useEffect(() => {
    if (!editorOrigin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== editorOrigin) return; // чужие фреймы игнорируем
      let payload: { MessageId?: string; Values?: Record<string, unknown> };
      try {
        payload = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data ?? {});
      } catch {
        return;
      }
      switch (payload.MessageId) {
        case 'App_LoadingStatus':
          if (payload.Values?.Status === 'Document_Loaded') {
            setLoaded(true);
            // Без этого ответа редактор не начнёт слать хосту события вообще.
            const frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${FRAME_NAME}"]`);
            frame?.contentWindow?.postMessage(
              JSON.stringify({ MessageId: 'Host_PostmessageReady' }),
              editorOrigin,
            );
          }
          break;
        case 'Doc_ModifiedStatus':
          setModified(payload.Values?.Modified === true);
          break;
        case 'Document_Modified':
          setModified(true);
          break;
        case 'UI_Close':
        case 'close':
          closeDocument();
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [editorOrigin, closeDocument]);

  /**
   * Переход «просмотр → правка». Перезапрашиваем сессию уже без readonly: приходит
   * токен с UserCanWrite, форма перепощивается в тот же iframe, и редактор
   * перезагружается в режиме правки. Адрес обновляем replace'ом — обновление
   * страницы не должно молча возвращать в просмотр.
   */
  const switchToEdit = useCallback(() => {
    setReadonly(false);
    const params = new URLSearchParams();
    if (refType && refId) {
      params.set('refType', refType);
      params.set('refId', refId);
    }
    const query = params.toString();
    router.replace(`/docs/${documentId}${query ? `?${query}` : ''}`);
  }, [documentId, refType, refId, router]);

  // Кнопку показываем, только когда переход реально возможен: человек открыл на
  // просмотр И по правам может править (иначе это обещание, которое не сбудется).
  const canSwitchToEdit = session?.mode === 'view' && doc?.access === 'edit';

  const saveVersion = useMutation({
    mutationFn: () => saveDocumentVersion(documentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: documentVersionsKey(documentId) });
    },
  });

  if (authLoading) return <p className="label-md" style={{ padding: 'var(--spacing-4)' }}>Загрузка…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--surface)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-3)',
          padding: '0.6rem 1rem',
          background: 'var(--surface-container)',
        }}
      >
        <button
          type="button"
          onClick={closeDocument}
          className="btn-ghost"
          title="Закрыть документ"
          style={{ fontSize: '0.85rem', border: 'none', background: 'transparent', cursor: 'pointer' }}
        >
          ✕ Закрыть
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="title-sm"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={doc?.title}
          >
            {doc?.title ?? 'Документ'}
          </div>
          <div className="label-sm" style={{ fontSize: '0.72rem', color: 'var(--on-surface-variant)' }}>
            {session?.mode === 'view'
              ? 'Только просмотр'
              : modified
                ? 'Есть несохранённые правки'
                : 'Правки сохраняются автоматически · Версия будет создана после закрытия документа'}
          </div>
        </div>
        {canSwitchToEdit && (
          <button
            type="button"
            onClick={switchToEdit}
            title="Перейти в режим правки: изменения увидят все, кому доступен файл"
            style={{
              padding: '0.35rem 0.8rem',
              borderRadius: 'var(--radius-sketch)',
              border: 'none',
              background: 'var(--primary-container, var(--surface-container-high))',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            ✏️ Редактировать
          </button>
        )}
        {session?.mode === 'edit' && (
          <button
            type="button"
            onClick={() => saveVersion.mutate()}
            disabled={saveVersion.isPending || !loaded}
            style={{
              padding: '0.35rem 0.8rem',
              borderRadius: 'var(--radius-sketch)',
              border: 'none',
              background: 'var(--surface-container-high)',
              cursor: saveVersion.isPending || !loaded ? 'default' : 'pointer',
              fontSize: '0.8rem',
              fontWeight: 600,
            }}
            title="Зафиксировать текущее содержимое отдельной версией"
          >
            {saveVersion.isSuccess && !saveVersion.isPending ? '✓ Версия сохранена' : 'Сохранить версию'}
          </button>
        )}
      </header>

      {error && (
        <div style={{ padding: 'var(--spacing-4)' }}>
          <p className="body-md" style={{ color: 'var(--error)' }}>{error}</p>
        </div>
      )}

      {/* Скрытая форма: POST'ит токен прямо в iframe (в URL его класть нельзя) */}
      {session && (
        <form ref={formRef} action={session.editorUrl} target={FRAME_NAME} method="post" style={{ display: 'none' }}>
          <input type="hidden" name="access_token" value={session.accessToken} />
          {/* ВНИМАНИЕ: по протоколу это МЕТКА ВРЕМЕНИ в мс, а не длительность */}
          <input type="hidden" name="access_token_ttl" value={String(session.accessTokenTtl)} />
        </form>
      )}

      <iframe
        name={FRAME_NAME}
        title={doc?.title ?? 'Документ'}
        allow="clipboard-read; clipboard-write; fullscreen"
        style={{ flex: 1, width: '100%', border: 'none', background: 'var(--surface)' }}
      />
    </div>
  );
}
