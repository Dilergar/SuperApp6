'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { IdempotencyKeyLookupDto, IdempotencyState, PlatformCommandDto } from '@superapp/shared';
import { Button, Card, CardHeader, Chip, EmptyState, type Tone } from '@/components/ui';
import { useFormatters } from '@/lib/format';
import { fetchPlatformCommands, platformCommandsKey } from '@/lib/platform/api';
import { CommandRunner } from './CommandRunner';

// ============================================================
// «Мой запрос прошёл?» — разбор с интегратором по ключу повтора.
//
// Тела ответов здесь не показываются НИКОГДА: они лежат под KEK владельца, и спор
// решают факты — сколько раз клиент приходил, чем кончилась первая попытка, какая
// сущность получилась. Сам ключ в журнал кабинета не попадает (`redact`).
// ============================================================

const STATE_TONE: Record<IdempotencyState, Tone> = {
  in_progress: 'waiting',
  committed: 'warning',
  completed: 'success',
  released: 'neutral',
};

export function IdempotencyLookup() {
  const t = useTranslations('platform');
  const f = useFormatters();
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const command: PlatformCommandDto | null = commandsQ.data?.find((c) => c.key === 'idempotency.key.lookup') ?? null;
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<IdempotencyKeyLookupDto | null>(null);

  // Нет способности — нет и раздела (команда просто не приехала в реестре)
  if (!command) return null;

  return (
    <Card>
      <CardHeader
        title={t('commands.idempotencyKeyLookup.title')}
        actions={
          <Button size="sm" variant="ghost" icon="search" onClick={() => setOpen(true)}>
            {t('runner.run')}
          </Button>
        }
      />
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)' }}>
        {t('commands.idempotencyKeyLookup.description')}
      </p>

      {result &&
        (result.hits.length === 0 ? (
          <EmptyState icon="search" title={t('search.noResults')} description={t('search.emptyText')} />
        ) : (
          <div className="ui-stack" style={{ gap: '0.5rem' }}>
            {result.hits.map((h, i) => (
              <div
                key={`${h.route}:${h.createdAt}:${i}`}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
              >
                <Chip tone={STATE_TONE[h.state]} size="sm">
                  {t(`idempotencyState.${h.state}`)}
                </Chip>
                <span className="body-sm" style={{ fontWeight: 600 }}>
                  {h.method} {h.route}
                </span>
                <span className="label-sm">{f.dateTime(h.createdAt)}</span>
                {h.httpStatus !== null && <Chip tone="neutral" size="sm">{h.httpStatus}</Chip>}
                {h.replays > 0 && (
                  <Chip tone="warning" size="sm">
                    {t('fields.repeated')}: {h.replays}
                  </Chip>
                )}
                {h.errorCode && <Chip tone="danger" size="sm">{h.errorCode}</Chip>}
                {h.resourceId && <span className="label-sm">{h.resourceId}</span>}
              </div>
            ))}
          </div>
        ))}

      {open && (
        <CommandRunner
          command={command}
          open
          onClose={() => setOpen(false)}
          onDone={(res) => setResult((res.result as IdempotencyKeyLookupDto | undefined) ?? null)}
        />
      )}
    </Card>
  );
}
