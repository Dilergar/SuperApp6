'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentOpenDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage } from '@/lib/api';
import { chronicleKey, documentKey, documentVersionsKey } from '@/lib/queries';
import { getDocument, openDocument, saveDocumentVersion } from '@/lib/docs-api';
import { Modal } from '@/components/ui/Modal';
import { ShareLinkSection } from '@/components/ShareLinkSection';
import { DocumentHistory } from './DocumentHistory';

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
  const { isReady, user } = useRequireAuth();
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

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
   * Закрытие документа.
   *
   * ВАЖНО: опираться на window.history.length здесь НЕЛЬЗЯ. Каждая навигация iframe'а
   * попадает в СОВМЕСТНУЮ историю вкладки, и после перехода «просмотр → правка» (форма
   * пост'ится в редактор второй раз) длина истории всегда > 1 — «Закрыть» превращался
   * в «шаг назад», то есть возвращал предыдущий документ редактора вместо закрытия
   * вкладки. В режиме просмотра форма пост'ится ровно один раз, в пустой iframe, и такая
   * навигация историю не растит — поэтому там кнопка работала, а после правки нет.
   *
   * Признак «вкладку открыли мы» — живой opener (FileChip открывает её через
   * window.open без noopener именно ради этого). Такую вкладку скрипту закрывать можно
   * независимо от истории. Пришли по прямой ссылке — возвращаем в место, откуда документ
   * растёт (задача/чат), а не «назад» вслепую.
   */
  const closeDocument = useCallback(() => {
    if (window.opener) {
      window.close();
      return;
    }
    if (refType === 'task' && refId) router.push(`/tasks/${refId}`);
    else if (refType === 'chat_message') router.push('/messenger');
    else router.push('/dashboard');
  }, [router, refType, refId]);

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
    mutationFn: () => saveDocumentVersion(documentId, place),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: documentVersionsKey(documentId) });
      void qc.invalidateQueries({ queryKey: chronicleKey('document', documentId) });
      setHistoryOpen(true); // результат нажатия должен быть виден сразу
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
          title="Закрыть документ"
          style={{
            fontSize: '0.85rem',
            fontWeight: 600,
            // Уход со страницы — действие с последствиями, поэтому красный: тот же
            // --danger, что у «Опасной зоны» профиля, но мягким washem, а не заливкой
            color: 'var(--danger)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            border: 'none',
            borderRadius: 'var(--radius-sketch)',
            padding: '0.35rem 0.7rem',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
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
              // Зелёный «разрешающий» — противовес красной кнопке ухода
              color: 'var(--success)',
              background: 'color-mix(in srgb, var(--success) 14%, transparent)',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            ✏️ Редактировать
          </button>
        )}
        {/* Наружу документ раздаёт ТОЛЬКО владелец: право правки часто приходит «от
            места» (например, у всех участников задачи), и его не должно хватать,
            чтобы вынести чужой файл во внешний мир. */}
        {doc && user?.id === doc.createdById && (
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            title="Поделиться ссылкой с тем, у кого нет аккаунта"
            style={{
              padding: '0.35rem 0.8rem',
              borderRadius: 'var(--radius-sketch)',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            🔗 Поделиться
          </button>
        )}
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          title="Версии документа и кто его правил"
          style={{
            padding: '0.35rem 0.8rem',
            borderRadius: 'var(--radius-sketch)',
            border: 'none',
            background: historyOpen ? 'var(--surface-container-high)' : 'transparent',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          🕘 История
        </button>
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
            {saveVersion.isSuccess && !saveVersion.isPending ? 'Версия сохранена' : 'Сохранить версию'}
          </button>
        )}
      </header>

      {error && (
        <div style={{ padding: 'var(--spacing-4)' }}>
          <p className="body-md" style={{ color: 'var(--error)' }}>{error}</p>
        </div>
      )}

      {/* Большой файл открывается долго — честная строчка вместо «зависшего» экрана */}
      {session?.warning && !loaded && (
        <div
          className="body-sm"
          style={{
            padding: '0.5rem 1rem',
            background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
            color: 'var(--warning)',
          }}
        >
          ⏳ {session.warning}
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

      {/*
        key меняется на каждую выданную сессию — iframe пересоздаётся, и form POST
        попадает в СВЕЖИЙ пустой фрейм. Навигация из начального about:blank идёт
        «с заменой» и историю вкладки не растит; без этого каждый перезапуск редактора
        (переход в правку, молчаливое продление токена) добавлял запись в совместную
        историю, и кнопки «назад»/«закрыть» начинали ходить по состояниям редактора.
      */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <iframe
          key={session ? `${session.mode}:${session.accessTokenTtl}` : 'idle'}
          name={FRAME_NAME}
          title={doc?.title ?? 'Документ'}
          allow="clipboard-read; clipboard-write; fullscreen"
          style={{ flex: 1, width: '100%', border: 'none', background: 'var(--surface)' }}
        />
        {historyOpen && (
          <DocumentHistory
            documentId={documentId}
            title={doc?.title ?? 'Документ'}
            place={place}
            canEdit={doc?.access === 'edit'}
            onClose={() => setHistoryOpen(false)}
            // Возврат версии подменяет байты, поэтому редактор на это время гасим:
            // session=null снимает iframe, и редактор отпускает документ (Unlock)
            onSuspendEditor={() => {
              setLoaded(false);
              setSession(null);
            }}
            onResumeEditor={() => void start()}
          />
        )}
      </div>

      {shareOpen && (
        <Modal open onClose={() => setShareOpen(false)} title="Поделиться документом" size="md">
          <p className="body-sm" style={{ margin: '0 0 var(--spacing-4)', color: 'var(--on-surface-variant)' }}>
            Гость увидит документ в виде PDF — читаемую копию текущего содержимого. Править и
            открывать исходник по ссылке нельзя.
          </p>
          <ShareLinkSection refType="document" refId={documentId} />
        </Modal>
      )}
    </div>
  );
}
