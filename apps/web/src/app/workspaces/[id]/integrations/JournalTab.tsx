'use client';

// Журнал действий с ключами (append-only): кто, что, когда, почему. Ключевого материала здесь нет.
// Фильтр — по виду предмета (боты / ключи / вебхуки) либо по одному предмету («Только «…»»),
// когда журнал открыт из строки реестра или карточки бота.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery } from '@tanstack/react-query';
import { KEYS_LIMITS, type KeyActorLiteDto, type KeyAuditEntryDto, type KeyJournalQuery } from '@superapp/shared';
import { PersonChip } from '@/app/circles/PersonCard';
import { useFormatters } from '@/lib/format';
import { fetchKeysJournal } from '@/lib/keys-api';
import { keysJournalKey } from '@/lib/queries';
import { BotChip } from '@/components/keys';
import { Button, Card, Chip, EmptyState, LoadingBlock, Table, TableCell, TableRow, type IconName, type TableColumn } from '@/components/ui';

export type JournalSubjectType = NonNullable<KeyJournalQuery['subjectType']>;
/** Один предмет журнала (строка реестра, бот) — фокус, приходящий с другой вкладки */
export interface JournalFocus {
  subjectType: JournalSubjectType;
  subjectId: string;
  name: string;
}

const SUBJECT_TYPES: JournalSubjectType[] = ['bot', 'api_key', 'webhook_endpoint'];
const SUBJECT_ICON: Record<string, IconName> = { bot: 'robot', api_key: 'key', webhook_endpoint: 'webhook', policy: 'shield', crypto_key: 'lock' };

/** Действие журнала → ключ подписи (точки → `_`: next-intl не допускает точку в сегменте; неизвестное показывается как есть). */
const KNOWN_ACTIONS = new Set([
  'bot.created', 'bot.updated', 'bot.frozen', 'bot.unfrozen', 'bot.archived',
  'api_key.created', 'api_key.rotated', 'api_key.revoked', 'api_key.updated',
  'policy.updated',
  'webhook.endpoint.created', 'webhook.endpoint.updated', 'webhook.endpoint.disabled', 'webhook.endpoint.enabled', 'webhook.endpoint.deleted', 'webhook.endpoint.secret_rotated', 'webhook.endpoint.verified',
  'crypto_key.created', 'key_version.created', 'key_version.activated', 'key_version.disabled', 'key_version.enabled', 'key_version.destroy_scheduled', 'key_version.destroyed', 'scope.frozen', 'scope.unfrozen', 'scope.rewrapped', 'root.rotated',
]);

export function JournalTab({ workspaceId, focus, onClearFocus }: { workspaceId: string; focus?: JournalFocus | null; onClearFocus?: () => void }) {
  const t = useTranslations('keys');
  const fmt = useFormatters();
  const [subjectType, setSubjectType] = useState<JournalSubjectType | null>(null);
  const filter: Pick<KeyJournalQuery, 'subjectType' | 'subjectId'> = focus
    ? { subjectType: focus.subjectType, subjectId: focus.subjectId }
    : subjectType
      ? { subjectType }
      : {};
  const q = useInfiniteQuery({
    queryKey: keysJournalKey(workspaceId, filter.subjectType ?? null, filter.subjectId ?? null),
    queryFn: ({ pageParam }) => fetchKeysJournal(workspaceId, { ...filter, ...(pageParam ? { cursor: pageParam as string } : {}), limit: KEYS_LIMITS.journalPageSize }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const actors = useMemo(() => {
    const merged: Record<string, KeyActorLiteDto> = {};
    for (const p of q.data?.pages ?? []) Object.assign(merged, p.actors);
    return merged;
  }, [q.data]);

  const columns: TableColumn[] = [
    { key: 'when', label: t('journal.columns.when'), width: '11rem' },
    { key: 'actor', label: t('journal.columns.actor'), hideOnMobile: true },
    { key: 'action', label: t('journal.columns.action') },
    { key: 'subject', label: t('journal.columns.subject'), hideOnMobile: true },
    { key: 'reason', label: t('journal.columns.reason'), hideOnMobile: true },
  ];

  const actorOf = (e: KeyAuditEntryDto) => {
    if (!e.actorId) return <Chip size="sm" tone="neutral" icon="settings">{t(`journal.actorKind.${e.actorKind === 'platform' ? 'platform' : 'system'}`)}</Chip>;
    const a = actors[e.actorId];
    if (!a) return <span className="label-sm">{e.actorKind === 'platform' ? t('journal.actorKind.platform') : '—'}</span>;
    if (a.kind === 'bot') return <BotChip name={a.firstName} size="xs" />;
    return <PersonChip size="XS" userId={a.id} firstName={a.firstName} lastName={a.lastName} avatar={a.avatar} />;
  };

  const filters = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: 'var(--spacing-4)' }} role="group" aria-label={t('journal.filters.aria')}>
      {focus ? (
        <Chip size="sm" tone="accent" icon={SUBJECT_ICON[focus.subjectType]} selected onRemove={onClearFocus} removeLabel={t('journal.focusRemove')}>
          {t('journal.focus', { name: focus.name })}
        </Chip>
      ) : (
        <>
          <Chip size="sm" tone="accent" selected={subjectType === null} onClick={() => setSubjectType(null)}>{t('journal.filters.all')}</Chip>
          {SUBJECT_TYPES.map((s) => (
            <Chip key={s} size="sm" tone="accent" icon={SUBJECT_ICON[s]} selected={subjectType === s} onClick={() => setSubjectType(subjectType === s ? null : s)}>{t(`journal.filters.${s}`)}</Chip>
          ))}
        </>
      )}
    </div>
  );

  return (
    <Card>
      {filters}
      {q.isPending ? (
        <LoadingBlock />
      ) : entries.length === 0 ? (
        <EmptyState icon="journal" title={t('journal.empty.title')} description={t('journal.empty.body')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('journal.tableAria')}>
            {entries.map((e, i) => (
              <TableRow key={e.id} rowIndex={i + 2}>
                <TableCell><span className="label-sm">{fmt.dateTime(e.occurredAt, 'short')}</span></TableCell>
                <TableCell hideOnMobile>{actorOf(e)}</TableCell>
                <TableCell>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                    <Chip size="sm" tone={toneOf(e.action)} icon={SUBJECT_ICON[e.subjectType]}>{KNOWN_ACTIONS.has(e.action) ? t(`journal.action.${e.action.replace(/\./g, '_')}`) : e.action}</Chip>
                  </span>
                </TableCell>
                <TableCell hideOnMobile><span style={{ fontSize: '0.88rem' }}>{e.subjectName ?? e.subjectId}</span></TableCell>
                <TableCell hideOnMobile><span className="label-sm">{e.reason ?? detailsLine(e.details)}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
          <Button variant="ghost" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>{t('registry.loadMore')}</Button>
        </div>
      )}
    </Card>
  );
}

function toneOf(action: string): 'success' | 'warning' | 'danger' | 'waiting' | 'neutral' | 'accent' {
  if (action.endsWith('.created') || action.endsWith('.unfrozen') || action.endsWith('.enabled') || action.endsWith('.activated') || action.endsWith('.verified')) return 'success';
  if (action.endsWith('.frozen') || action.endsWith('.disabled')) return 'waiting';
  if (action.endsWith('.revoked') || action.endsWith('.archived') || action.endsWith('.deleted') || action.endsWith('.destroyed')) return 'neutral';
  if (action.endsWith('.rotated') || action.endsWith('.secret_rotated') || action.endsWith('.rewrapped')) return 'accent';
  return 'neutral';
}

/** Короткая машинная строка из details (код причины, префикс ключа) — без перевода значений. */
function detailsLine(details: Record<string, unknown> | null): string {
  if (!details) return '';
  const parts: string[] = [];
  if (typeof details.reason === 'string') parts.push(details.reason);
  if (typeof details.prefix === 'string') parts.push(details.prefix);
  if (typeof details.kind === 'string') parts.push(details.kind);
  return parts.join(' · ');
}
