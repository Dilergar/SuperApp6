'use client';

// ============================================================
// Обозреватель розданных наружу ссылок — ОДИН на два скоупа:
//   «Мои ссылки» (профиль) и «Ссылки организации» (команда, Менеджер+).
//
// Копировать страницу под второй скоуп нельзя: следующая правка (новый фильтр,
// новая колонка, новое поле ссылки) разъехалась бы между двумя копиями — а это
// раздел, в который приходят разбираться, куда ушли данные, и он обязан быть
// одинаковым в обоих местах. Отличия скоупов приходят пропсами: загрузчики,
// ключи кэша и колонка «кто раздал».
// ============================================================

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SHARE_LINK_STATUS_LABELS,
  shareLinkStatus,
  type ShareLinkActorLite,
  type ShareLinkMineDto,
  type ShareLinkMinePage,
  type ShareLinkOrgPage,
  type ShareLinkStatsDto,
} from '@superapp/shared';
import { Button, Card, Checkbox, Chip, EmptyState, Icon, LoadingBlock, useConfirm } from '@/components/ui';
import type { Tone } from '@/components/ui/tones';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';

export type ShareLinksFilter = 'active' | 'inactive' | 'all';

/**
 * Страница списка. Компонент обслуживает ДВА скоупа, поэтому объединение здесь
 * уместно по существу — но собирается оно из shared-типов, а не переписывается
 * от руки (`actors` есть только у организационного вида).
 */
export type ShareLinksPageResult = ShareLinkMinePage | ShareLinkOrgPage;

export interface ShareLinksSource {
  /** Префикс ключа кэша — по нему инвалидируется весь скоуп после отзыва */
  keyPrefix: readonly unknown[];
  list: (params: { status: ShareLinksFilter; cursor?: string }) => Promise<ShareLinksPageResult>;
  stats: () => Promise<ShareLinkStatsDto>;
  revoke: (ids: string[]) => Promise<number>;
  /** Показывать «кто раздал» (организационный вид; в личном автор всегда один) */
  showAuthors?: boolean;
}

const FILTERS: { key: ShareLinksFilter; label: string }[] = [
  { key: 'active', label: 'Действуют' },
  { key: 'inactive', label: 'Недействующие' },
  { key: 'all', label: 'Все' },
];

const STATUS_TONE: Record<string, Tone> = {
  active: 'success',
  revoked: 'danger',
  expired: 'neutral',
  exhausted: 'neutral',
};

export function ShareLinksBrowser({
  title,
  subtitle,
  emptyDescription,
  source,
}: {
  title: string;
  subtitle: string;
  emptyDescription: string;
  source: ShareLinksSource;
}) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [filter, setFilter] = useState<ShareLinksFilter>('active');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const { data: stats } = useQuery({
    queryKey: [...source.keyPrefix, 'stats'],
    queryFn: source.stats,
  });

  // Постраничный обход, а не одна страница: у команды ссылок бывает много, и «первые
  // 30 и всё» — это молчаливая обрезка ровно того списка, ради полноты которого раздел
  // и существует.
  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: [...source.keyPrefix, 'list', filter],
    queryFn: ({ pageParam }) => source.list({ status: filter, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const links = useMemo(() => (data?.pages ?? []).flatMap((p) => p.items), [data]);
  const actors = useMemo(() => {
    const map: Record<string, ShareLinkActorLite> = {};
    // `actors` есть только у организационного скоупа — сужаем союз, а не гадаем.
    for (const p of data?.pages ?? []) if ('actors' in p) Object.assign(map, p.actors);
    return map;
  }, [data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: source.keyPrefix });
  };

  const revoke = useMutation({
    mutationFn: (ids: string[]) => source.revoke(ids),
    onSuccess: () => {
      setPicked(new Set());
      refresh();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const revokable = links.filter((l) => shareLinkStatus(l) === 'active');
  const pickedAlive = [...picked].filter((id) => revokable.some((l) => l.id === id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-5)' }}>
      <div>
        <h1 className="title-lg" style={{ margin: 0 }}>{title}</h1>
        <p className="body-sm" style={{ margin: '0.375rem 0 0', color: 'var(--on-surface-variant)' }}>
          {subtitle}
        </p>
      </div>

      {stats && <StatsBlock stats={stats} />}

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <Chip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Chip>
        ))}
        <span style={{ flex: 1 }} />
        {pickedAlive.length > 0 && (
          <Button
            size="sm"
            variant="matte"
            tone="danger"
            loading={revoke.isPending}
            onClick={() =>
              confirm(
                {
                  title: `Отозвать ссылки: ${pickedAlive.length}?`,
                  message: 'Открыть их больше не получится. Уже скачанные файлы это не вернёт.',
                  confirmLabel: 'Отозвать',
                  danger: true,
                },
                () => revoke.mutateAsync(pickedAlive).then(() => undefined),
              )
            }
          >
            Отозвать выбранные ({pickedAlive.length})
          </Button>
        )}
      </div>

      {isPending && <LoadingBlock />}
      {!isPending && links.length === 0 && (
        <EmptyState icon="link" title="Ссылок пока нет" description={emptyDescription} />
      )}

      {links.map((link) => (
        <LinkCard
          key={link.id}
          link={link}
          author={source.showAuthors ? (actors[link.createdById] ?? null) : null}
          showAuthor={!!source.showAuthors}
          picked={picked.has(link.id)}
          onPick={() => toggle(link.id)}
          onRevoke={(ids) => revoke.mutateAsync(ids).then(() => undefined)}
        />
      ))}

      {hasNextPage && (
        <div>
          <Button variant="ghost" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Показать ещё
          </Button>
        </div>
      )}

      {confirmUI}
    </div>
  );
}

/**
 * Сводка. Открытия считаются по журналу визитов за период, а не по счётчику ссылки:
 * человеку нужно «что происходит сейчас», а не «сколько было за всю жизнь».
 */
function StatsBlock({ stats }: { stats: ShareLinkStatsDto }) {
  const peak = useMemo(() => Math.max(1, ...stats.daily.map((d) => d.opens)), [stats.daily]);

  return (
    <Card>
      <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }}>
        <Metric value={stats.activeLinks} label="действующих ссылок" />
        <Metric value={stats.sharedObjects} label="объектов роздано" />
        <Metric value={stats.opensInPeriod} label={`открытий за ${stats.periodDays} дней`} />
      </div>

      {stats.opensInPeriod > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 2,
            height: 44,
            marginTop: 'var(--spacing-5)',
          }}
          role="img"
          aria-label={`Открытия по дням за ${stats.periodDays} дней, всего ${stats.opensInPeriod}`}
        >
          {stats.daily.map((d) => (
            <div
              key={d.date}
              title={`${new Date(d.date).toLocaleDateString('ru-RU')} — ${d.opens}`}
              style={{
                flex: 1,
                // Ноль тоже рисуем полоской в пиксель: пустое место в ряду читается как
                // «данных нет», а не как «в этот день не открывали».
                height: `${Math.max(1, Math.round((d.opens / peak) * 44))}px`,
                borderRadius: 2,
                background: d.opens ? 'var(--primary)' : 'var(--divider)',
              }}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="title-lg" style={{ lineHeight: 1.1 }}>{value}</div>
      <div className="meta">{label}</div>
    </div>
  );
}

function LinkCard({
  link,
  author,
  showAuthor,
  picked,
  onPick,
  onRevoke,
}: {
  link: ShareLinkMineDto;
  author: ShareLinkActorLite | null;
  showAuthor: boolean;
  picked: boolean;
  onPick: () => void;
  onRevoke: (ids: string[]) => Promise<void>;
}) {
  const status = shareLinkStatus(link);
  const alive = status === 'active';

  return (
    <Card>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-start' }}>
        {alive && (
          <Checkbox
            checked={picked}
            onChange={onPick}
            aria-label={`Выбрать ссылку на «${link.ref?.title ?? 'объект'}»`}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <Icon name={link.ref?.icon === 'folder' ? 'folder' : 'file'} size={16} style={{ color: 'var(--primary-dim)' }} />
            <span className="label-md" style={{ wordBreak: 'break-word' }}>
              {/* Объект мог исчезнуть — строку показываем всё равно: это история раздачи,
                  и отозвать такую ссылку человек тоже должен уметь. */}
              {link.ref?.title ?? 'Объект удалён'}
            </span>
            <Chip tone={STATUS_TONE[status] ?? 'neutral'}>{SHARE_LINK_STATUS_LABELS[status]}</Chip>
            {link.label && <span className="meta">для: {link.label}</span>}
            {link.hasPassword && (
              <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="lock" size={12} /> с паролем
              </span>
            )}
            {link.requireIdentity && (
              <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="user" size={12} /> по номеру
              </span>
            )}
            {!link.allowDownload && <span className="meta">без скачивания</span>}
          </div>

          {/* Кто раздал — главный вопрос организационного списка, и ответ на него
              обязан быть карточкой человека, а не строкой (принцип платформы). */}
          {showAuthor && (
            <div style={{ marginTop: '0.5rem' }}>
              {author ? (
                <PersonChip
                  size="S"
                  userId={author.id}
                  firstName={author.firstName}
                  lastName={author.lastName}
                  avatar={author.avatar}
                />
              ) : (
                <span className="meta">автор недоступен</span>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <span className="meta">
              открытий: {link.openCount}
              {link.maxOpens ? ` из ${link.maxOpens}` : ''}
            </span>
            {link.lastOpenedAt && (
              <span className="meta">последнее — {new Date(link.lastOpenedAt).toLocaleString('ru-RU')}</span>
            )}
            {link.expiresAt && <span className="meta">до {new Date(link.expiresAt).toLocaleDateString('ru-RU')}</span>}
            <span className="meta">создана {new Date(link.createdAt).toLocaleDateString('ru-RU')}</span>
          </div>
        </div>

        {alive && (
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexShrink: 0 }}>
            {/* Скопировать адрес — здесь это главное действие после «отозвать»: раздел
                затем и нужен, чтобы найти давнюю ссылку и переслать её ещё раз. */}
            <CopyButton url={link.url} />
            <RevokeButton link={link} onRevoke={onRevoke} />
          </div>
        )}
      </div>
    </Card>
  );
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={copied ? 'check' : 'copy'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toastError('Не удалось скопировать — выделите адрес вручную');
        }
      }}
    >
      {copied ? 'Скопировано' : 'Копировать'}
    </Button>
  );
}

function RevokeButton({
  link,
  onRevoke,
}: {
  link: ShareLinkMineDto;
  onRevoke: (ids: string[]) => Promise<void>;
}) {
  const [confirm, confirmUI] = useConfirm();
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        tone="danger"
        loading={busy}
        onClick={() =>
          confirm(
            {
              title: 'Отозвать ссылку?',
              message: 'Открыть её больше не получится. Уже скачанные файлы это не вернёт.',
              confirmLabel: 'Отозвать',
              danger: true,
            },
            async () => {
              setBusy(true);
              try {
                await onRevoke([link.id]);
              } finally {
                setBusy(false);
              }
            },
          )
        }
      >
        Отозвать
      </Button>
      {confirmUI}
    </>
  );
}
