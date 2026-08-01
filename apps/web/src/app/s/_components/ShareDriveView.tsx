'use client';

// ============================================================
// Диск глазами гостя: папка (список с навигацией внутрь) и одиночный файл.
//
// Ссылки на байты живут ~10 минут, поэтому перед скачиванием мы всегда спрашиваем
// свежую: иначе кнопка «Скачать» на открытой полчаса вкладке вела бы в никуда.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import type { ShareDriveGuestView, ShareDriveNodeDto } from '@superapp/shared';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { EmptyState } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Feedback';
import { shareDriveList, shareDriveNode } from '@/lib/public-api';
import { driveIcon, humanSize, shortDate } from '@/app/drive/_components/drive-ui';

interface Crumb {
  id: string | null;
  name: string;
}

export function ShareDriveView({ view, session }: { view: ShareDriveGuestView; session: string }) {
  if (view.kind === 'file') return <ShareFileCard node={null} file={view.file} name={view.name} session={session} />;
  return <ShareFolderView rootName={view.name} session={session} />;
}

// ============================================================
// Папка
// ============================================================

function ShareFolderView({ rootName, session }: { rootName: string; session: string }) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: rootName }]);
  const [rows, setRows] = useState<ShareDriveNodeDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ShareDriveNodeDto | null>(null);

  const current = crumbs[crumbs.length - 1];

  const load = useCallback(
    async (parentId: string | null, append: boolean, from?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await shareDriveList(session, {
          ...(parentId ? { parentId } : {}),
          ...(from ? { cursor: from } : {}),
        });
        setRows((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch {
        setError('Не удалось загрузить содержимое');
      } finally {
        setLoading(false);
      }
    },
    [session],
  );

  useEffect(() => {
    void load(current.id, false);
  }, [current.id, load]);

  const openFolder = (node: ShareDriveNodeDto) => setCrumbs((c) => [...c, { id: node.id, name: node.name }]);
  const goTo = (index: number) => setCrumbs((c) => c.slice(0, index + 1));

  return (
    <>
      {/* В корне путь не рисуем: имя папки и так стоит заголовком страницы */}
      {crumbs.length > 1 && (
        <nav aria-label="Путь" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 'var(--spacing-4)' }}>
          {crumbs.map((c, i) => (
            <span key={`${c.id ?? 'root'}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {i > 0 && <Icon name="caretDown" size={12} style={{ transform: 'rotate(-90deg)', color: 'var(--on-surface-variant)' }} />}
              {i === crumbs.length - 1 ? (
                <span className="label-md">{c.name}</span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => goTo(i)}>
                  {c.name}
                </Button>
              )}
            </span>
          ))}
        </nav>
      )}

      {loading && rows.length === 0 && <Spinner />}
      {error && (
        <p className="body-sm" style={{ color: 'var(--danger-text)' }}>
          {error}
        </p>
      )}
      {!loading && !error && rows.length === 0 && <EmptyState icon="folder" title="Папка пуста" />}

      {/* Список — настоящие ul/li, кнопка ВНУТРИ строки. Раньше role="listitem" стояла
          на самой button и перекрывала её роль: в дереве доступности строка была
          «элементом списка», и человек со скринридером не слышал, что по ней можно
          нажать. Это единственная страница продукта, которую видят посторонние. */}
      {rows.length > 0 && (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: 0, padding: 0, listStyle: 'none' }}>
          {rows.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => (node.kind === 'folder' ? openFolder(node) : setPreview(node))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid transparent',
                  background: 'transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
                className="share-row"
              >
                <Icon name={driveIcon(node)} size={18} style={{ color: 'var(--primary-dim)', flexShrink: 0 }} />
                <span className="body-md" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.name}
                </span>
                <span className="meta" style={{ flexShrink: 0 }}>{node.size === null ? '—' : humanSize(node.size)}</span>
                <span className="meta" style={{ flexShrink: 0 }}>{shortDate(node.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'center' }}>
          <Button variant="ghost" onClick={() => void load(current.id, true, cursor)} disabled={loading}>
            Показать ещё
          </Button>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 'var(--spacing-5)', paddingTop: 'var(--spacing-5)', borderTop: '1px solid var(--divider)' }}>
          <ShareFileCard node={preview} file={preview.file} name={preview.name} session={session} onClose={() => setPreview(null)} />
        </div>
      )}

      <style>{`.share-row:hover { background: var(--surface-container); }`}</style>
    </>
  );
}

// ============================================================
// Файл: превью по классу содержимого + скачивание свежей ссылкой
// ============================================================

function ShareFileCard({
  node,
  file,
  name,
  session,
  onClose,
}: {
  node: ShareDriveNodeDto | null;
  file: ShareDriveNodeDto['file'];
  name: string;
  session: string;
  onClose?: () => void;
}) {
  const [current, setCurrent] = useState(file);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCurrent(file), [file]);

  /** Ссылка живёт ~10 минут: перед скачиванием берём свежую, если срок близок */
  const freshUrl = useCallback(async (): Promise<string | null> => {
    if (!current) return null;
    const expired = !current.urlExpiresAt || new Date(current.urlExpiresAt).getTime() - Date.now() < 30_000;
    if (!expired) return current.url;
    if (!node) return current.url;
    setBusy(true);
    try {
      const fresh = await shareDriveNode(session, node.id);
      setCurrent(fresh.file);
      return fresh.file?.url ?? null;
    } catch {
      return current.url;
    } finally {
      setBusy(false);
    }
  }, [current, node, session]);

  const download = async () => {
    const url = await freshUrl();
    if (url) window.open(url, '_blank', 'noopener');
  };

  if (!current || !current.available) {
    return (
      <div style={{ textAlign: 'center', padding: 'var(--spacing-5) 0' }}>
        <Icon name="warningCircle" size={28} style={{ color: 'var(--on-surface-variant)' }} />
        <p className="body-sm" style={{ margin: '0.5rem 0 0' }}>
          Файл недоступен — он ещё обрабатывается или заблокирован проверкой безопасности.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 'var(--spacing-4)' }}>
        <Icon name={driveIcon({ kind: 'file', file: current })} size={20} style={{ color: 'var(--primary-dim)' }} />
        <span className="title-sm" style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{name}</span>
        <span className="meta">{humanSize(current.size)}</span>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Закрыть просмотр">
            ✕
          </Button>
        )}
      </div>

      {current.kind === 'image' && current.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={current.url}
          alt={name}
          style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)', display: 'block', margin: '0 auto' }}
        />
      )}
      {current.kind === 'video' && current.url && (
        <video src={current.url} poster={current.posterUrl ?? undefined} controls style={{ width: '100%', borderRadius: 'var(--radius-md)' }} />
      )}
      {current.kind === 'audio' && current.url && <audio src={current.url} controls style={{ width: '100%' }} />}

      <div style={{ marginTop: 'var(--spacing-4)' }}>
        <Button icon="download" onClick={() => void download()} loading={busy}>
          Скачать
        </Button>
      </div>
    </div>
  );
}
