'use client';

// ============================================================
// Матрица прав ключа: сервис × уровень (нет / чтение / запись). Строки — реестр
// KEY_SCOPE_SERVICES (сервер отдаёт /keys/scope-matrix: открыт ли ботам, потолок).
// Для бота сервисы «между людьми» недоступны, у некоторых потолок «чтение» —
// матрица не предлагает того, что сервер отвергнет.
// ============================================================

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { KEY_SCOPE_SERVICES, type KeyScopeLevel, type KeyScopeService, type KeyScopes } from '@superapp/shared';
import { Chip, Skeleton } from '@/components/ui';
import { fetchScopeMatrix } from '@/lib/keys-api';
import { keysScopeMatrixKey } from '@/lib/queries';

type Level = KeyScopeLevel | 'none';
const LEVELS: Level[] = ['none', 'read', 'write'];

export function ScopeMatrix({
  value,
  onChange,
  forBot,
  readOnly,
}: {
  value: KeyScopes;
  onChange?: (next: KeyScopes) => void;
  /** Бот: закрытые сервисы недоступны, потолки уровня применяются */
  forBot: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations('keys');
  const matrix = useQuery({ queryKey: keysScopeMatrixKey, queryFn: fetchScopeMatrix, staleTime: Infinity });
  const rows = useMemo(() => {
    const services = matrix.data?.services ?? [];
    const order = (s: KeyScopeService) => KEY_SCOPE_SERVICES[s]?.order ?? 999;
    return [...services].sort((a, b) => order(a.service) - order(b.service));
  }, [matrix.data]);

  if (matrix.isPending) return <Skeleton style={{ height: 160 }} />;

  const set = (service: KeyScopeService, level: Level) => {
    if (!onChange || readOnly) return;
    const next: KeyScopes = { ...value };
    if (level === 'none') delete next[service];
    else next[service] = level;
    onChange(next);
  };

  const selectedCount = Object.keys(value).length;

  return (
    <div role="group" aria-label={t('scope.matrixAria')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      <div className="label-sm" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{t('scope.selected', { count: selectedCount })}</span>
        {!readOnly && onChange && selectedCount > 0 && (
          <button type="button" className="btn-ghost-inline" style={{ fontSize: '0.8rem' }} onClick={() => onChange({})}>
            {t('scope.clear')}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {rows.map((row) => {
          const closed = forBot && !row.bot;
          const max: KeyScopeLevel = forBot ? row.botMax : 'write';
          const current: Level = value[row.service] ?? 'none';
          return (
            <div
              key={row.service}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--spacing-3)',
                padding: '0.375rem 0.625rem',
                borderRadius: 'var(--radius-sm)',
                background: current !== 'none' ? 'var(--surface-container-low)' : 'transparent',
                opacity: closed ? 0.55 : 1,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontSize: '0.9rem' }}>{t(`service.${row.service}`)}</span>
                {closed && <span className="label-sm">{t('scope.botClosed')}</span>}
                {!closed && forBot && row.botMax === 'read' && <span className="label-sm">{t('scope.botReadOnly')}</span>}
              </span>
              <span role="radiogroup" aria-label={t(`service.${row.service}`)} style={{ display: 'inline-flex', gap: '0.25rem' }}>
                {LEVELS.map((lvl) => {
                  const beyond = lvl === 'write' && max === 'read';
                  const disabled = closed || beyond || readOnly;
                  const selected = current === lvl;
                  return (
                    <Chip
                      key={lvl}
                      size="sm"
                      tone={lvl === 'write' ? 'accent' : lvl === 'read' ? 'success' : 'neutral'}
                      selected={selected}
                      onClick={disabled ? undefined : () => set(row.service, lvl)}
                      title={beyond ? t('scope.botReadOnly') : undefined}
                      style={disabled && !selected ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                    >
                      {t(`scope.level.${lvl}`)}
                    </Chip>
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Сводка скоупов для реестра: «Задачи: запись · Документы: чтение». */
export function ScopeSummary({ scopes, max = 3 }: { scopes: KeyScopes; max?: number }) {
  const t = useTranslations('keys');
  const entries = Object.entries(scopes) as [KeyScopeService, KeyScopeLevel][];
  if (!entries.length) return <span className="label-sm">{t('scope.none')}</span>;
  const shown = entries.slice(0, max);
  const rest = entries.length - shown.length;
  return (
    <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
      {shown.map(([s, l]) => (
        <Chip key={s} size="sm" tone={l === 'write' ? 'accent' : 'success'} title={`${t(`service.${s}`)}: ${t(`scope.level.${l}`)}`}>
          {t(`service.${s}`)}
        </Chip>
      ))}
      {rest > 0 && <Chip size="sm" tone="neutral">+{rest}</Chip>}
    </span>
  );
}
