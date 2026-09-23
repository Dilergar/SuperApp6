'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type {
  AnalyticsActivityPanelDto,
  EntitlementSubjectDetailDto,
  PlatformAuditPageDto,
  PlatformCommandDto,
  PlatformEntity,
  PlatformPanelDataDto,
  PlatformPanelRefDto,
  PlatformPiiRevealResultDto,
  PlatformStaffDto,
  PlatformUserHitDto,
  PlatformWorkspaceHitDto,
  PlatformUserSecurityPanelDto,
  PlatformWorkspaceSecurityPanelDto,
} from '@superapp/shared';
import { Alert, BentoGrid, Button, Card, CardHeader, Chip, LoadingBlock, Menu, PageHeader, type MenuAction } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { fetchPlatformEntity, fetchPlatformPanel, platformEntityKey, platformPanelKey, platformRootKey } from '@/lib/platform/api';
import { useFormatters } from '@/lib/format';
import { CommandRunner } from './CommandRunner';
import { AuditRows } from './AuditRows';
import { SubjectEntitlements } from './SubjectEntitlements';
import { ActivityPanel } from './analytics/ActivityPanel';
import { UserSecurityPanel, WorkspaceSecurityPanel } from './SecurityPanel';

// ============================================================
// Карточка 360: шапка + чипы состояния + меню «Действия» из команд реестра (без права —
// пункта нет) + бенто панелей из реестра: первые три сразу, остальные по раскрытию;
// каждая панель — Card со своей загрузкой, ошибкой и повтором. PII маскирован; кнопка
// «Показать» выполняет команду `platform.pii.reveal` (причина обязательна), раскрытое
// живёт до перезагрузки страницы.
// ============================================================

export function EntityCard({ entity, id }: { entity: PlatformEntity; id: string }) {
  const t = useTranslations('platform');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: platformEntityKey(entity, id), queryFn: () => fetchPlatformEntity(entity, id) });
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  // Переход между панелями («упирался в тариф» → панель тарифов): счётчик — чтобы повторный клик сработал снова
  const [focus, setFocus] = useState<{ key: string; n: number } | null>(null);
  const data = q.data;

  const actions: MenuAction[] = useMemo(() => {
    if (!data) return [];
    return data.commands.map((c) => ({
      key: c.key,
      label: t(c.titleKey.replace(/^platform\./, '')),
      danger: c.risk === 'critical',
      onClick: () => setRunner({ command: c, input: initialInputFor(c, entity, id) }),
    }));
  }, [data, entity, id, t]);

  if (q.isPending) return <LoadingBlock />;
  if (q.isError || !data) return <Alert tone="danger">{t('card.notFound')}</Alert>;

  const revealCommand = data.commands.find((c) => c.key === 'platform.pii.reveal') ?? null;
  // Ссылка на панель — только если она есть в карточке (без способности панели нет и ссылки)
  const panelOpener = (key: string) =>
    data.panels.some((p) => p.key === key) ? () => setFocus((prev) => ({ key, n: (prev?.n ?? 0) + 1 })) : undefined;

  return (
    <>
      <PageHeader
        breadcrumb={t(entity === 'user' ? 'card.user' : 'card.workspace')}
        title={<Header header={data.header} />}
        chip={
          <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            {data.chips.map((c) => (
              <Chip key={c.key} tone={c.tone} size="sm">{t(`chips.${c.key}`, c.params as Record<string, string | number> | undefined)}</Chip>
            ))}
          </span>
        }
        actions={actions.length ? <Menu items={actions} label={t('card.actions')} /> : undefined}
      />
      <BentoGrid>
        {data.panels.map((p) => (
          <Panel
            key={p.key}
            entity={entity}
            id={id}
            panel={p}
            revealed={revealed}
            onReveal={revealCommand ? (fields) => setRunner({ command: revealCommand, input: { entity, id, fields } }) : undefined}
            focusSignal={focus?.key === p.key ? focus.n : 0}
            panelOpener={panelOpener}
          />
        ))}
      </BentoGrid>
      {runner && (
        <CommandRunner
          command={runner.command}
          initialInput={runner.input}
          open
          onClose={() => setRunner(null)}
          onDone={(res) => {
            if (runner.command.key === 'platform.pii.reveal' && res.result) {
              const r = res.result as PlatformPiiRevealResultDto;
              setRevealed((prev) => ({ ...prev, ...r.fields }));
            }
            void qc.invalidateQueries({ queryKey: platformRootKey });
          }}
        />
      )}
    </>
  );
}

function initialInputFor(c: PlatformCommandDto, entity: PlatformEntity, id: string): Record<string, unknown> {
  if (c.key.startsWith('platform.staff.')) return { userId: id };
  if (c.key === 'platform.pii.reveal') return { entity, id, fields: ['phone'] };
  if (c.key.startsWith('entitlements.')) return { subject: { type: entity, id } };
  return {};
}

function Header({ header }: { header: PlatformUserHitDto | PlatformWorkspaceHitDto }) {
  if (header.entity === 'user') {
    const name = `${header.person.firstName} ${header.person.lastName ?? ''}`.trim();
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}>
        <PersonAvatar userId={header.id} name={name} avatar={header.person.avatar} size="lg" />
        <span>
          {name}
          {header.phoneMasked && <span className="label-sm" style={{ marginLeft: '0.5rem' }}>{header.phoneMasked}</span>}
        </span>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}>
      {header.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={header.logo} alt="" width={40} height={40} style={{ borderRadius: 'var(--radius-md)', objectFit: 'cover' }} />
      ) : null}
      <span>
        {header.name}
        {header.binMasked && <span className="label-sm" style={{ marginLeft: '0.5rem' }}>{header.binMasked}</span>}
      </span>
    </span>
  );
}

function Panel({
  entity,
  id,
  panel,
  revealed,
  onReveal,
  focusSignal,
  panelOpener,
}: {
  entity: PlatformEntity;
  id: string;
  panel: PlatformPanelRefDto;
  revealed: Record<string, string | null>;
  onReveal?: (fields: string[]) => void;
  /** Растёт, когда соседняя панель просит показать эту */
  focusSignal: number;
  panelOpener: (key: string) => (() => void) | undefined;
}) {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const [expanded, setExpanded] = useState(panel.eager);
  useEffect(() => {
    if (!focusSignal) return;
    setExpanded(true);
    requestAnimationFrame(() => document.getElementById(panelDomId(panel.key))?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, [focusSignal, panel.key]);
  const q = useQuery({
    queryKey: platformPanelKey(entity, id, panel.key),
    queryFn: () => fetchPlatformPanel(entity, id, panel.key),
    enabled: expanded,
    retry: false,
  });
  const span = panel.key.endsWith('.entitlements') || panel.key.endsWith('.audit') || panel.key.endsWith('.security') ? 12 : 6;
  return (
    <Card span={span} id={panelDomId(panel.key)}>
      <CardHeader
        title={t(panel.titleKey.replace(/^platform\./, ''))}
        actions={
          !expanded ? (
            <Button size="sm" variant="ghost" icon="eye" onClick={() => setExpanded(true)}>{t('card.show')}</Button>
          ) : q.isError ? (
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void q.refetch()}>{tc('actions.retry')}</Button>
          ) : undefined
        }
      />
      {!expanded ? null : q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger">{t('card.panelFailed')}</Alert>
      ) : (
        <PanelBody panelKey={panel.key} entityId={id} data={loaded(q.data)} revealed={revealed} onReveal={onReveal} panelOpener={panelOpener} />
      )}
    </Card>
  );
}

const panelDomId = (key: string) => `platform-panel-${key.replace(/\./g, '-')}`;

/** Полезная нагрузка панели: DTO сам несёт поле `data` (это не конверт транспорта). */
function loaded(panel: PlatformPanelDataDto): unknown {
  return panel.data;
}

const PII_FIELDS: Record<string, string> = { phoneMasked: 'phone', iinMasked: 'iin', emailMasked: 'email' };

function PanelBody({
  panelKey,
  entityId,
  data,
  revealed,
  onReveal,
  panelOpener,
}: {
  panelKey: string;
  entityId: string;
  data: unknown;
  revealed: Record<string, string | null>;
  onReveal?: (fields: string[]) => void;
  panelOpener: (key: string) => (() => void) | undefined;
}) {
  const t = useTranslations('platform');
  // Роль в организации — продуктовая, её слово живёт в общем каталоге (`common.role.workspace.*`):
  // код роли в чипе читался бы как «staff» на любом языке
  const tc = useTranslations('common');
  const f = useFormatters();
  if (data === null || data === undefined) return <p className="label-sm">{t('card.empty')}</p>;

  if (panelKey.endsWith('.entitlements')) return <SubjectEntitlements detail={data as EntitlementSubjectDetailDto} />;
  if (panelKey === 'user.security') return <UserSecurityPanel data={data as PlatformUserSecurityPanelDto} userId={entityId} />;
  if (panelKey === 'workspace.security') return <WorkspaceSecurityPanel data={data as PlatformWorkspaceSecurityPanelDto} workspaceId={entityId} />;
  if (panelKey.endsWith('.audit')) return <AuditRows page={data as PlatformAuditPageDto} compact />;
  if (panelKey.endsWith('.analytics')) {
    return <ActivityPanel data={data as AnalyticsActivityPanelDto} onOpenPlans={panelOpener(panelKey.replace(/\.analytics$/, '.entitlements'))} />;
  }

  if (panelKey === 'user.staff') {
    const staff = data as PlatformStaffDto | null;
    if (!staff) return <p className="label-sm">{t('card.notStaff')}</p>;
    return (
      <div className="ui-stack" style={{ gap: '0.5rem' }}>
        <Chip tone={staff.status === 'active' ? 'success' : 'warning'} size="sm">{t(`staffStatus.${staff.status}`)}</Chip>
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          {staff.roles.map((r) => (
            <Chip key={r.role} tone="accent" size="sm">{t(`roles.${r.role}`)}</Chip>
          ))}
        </div>
      </div>
    );
  }

  if (panelKey === 'user.workspaces' && Array.isArray(data)) {
    const rows = data as Array<{ id: string; name: string; role: string; isActive: boolean; owner: boolean; since: string }>;
    if (!rows.length) return <p className="label-sm">{t('card.empty')}</p>;
    return (
      <div className="ui-stack" style={{ gap: '0.5rem' }}>
        {rows.map((w) => (
          <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Link href={`/platform/workspaces/${w.id}`} className="body-sm" style={{ fontWeight: 600 }}>{w.name}</Link>
            <Chip tone={w.owner ? 'accent' : 'neutral'} size="sm">{tc.has(`role.workspace.${w.role}`) ? tc(`role.workspace.${w.role}`) : w.role}</Chip>
            {!w.isActive && <Chip tone="warning" size="sm">{t('chips.inactive')}</Chip>}
            <span className="label-sm">{f.date(w.since)}</span>
          </div>
        ))}
      </div>
    );
  }

  // Профиль человека/организации и сводки — список «поле → значение» с раскрытием PII
  const obj = data as Record<string, unknown>;
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
  const nested = Object.entries(obj).filter(([, v]) => v && typeof v === 'object');
  return (
    <div className="ui-stack" style={{ gap: '0.375rem' }}>
      {entries.map(([k, v]) => {
        const pii = PII_FIELDS[k];
        const shown = pii && revealed[pii] !== undefined ? revealed[pii] : null;
        return (
          <div key={k} style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="label-caps" style={{ minWidth: '9rem' }}>{(t.has(`fields.${k}`) ? t(`fields.${k}`) : k)}</span>
            <span className="body-sm">{shown ?? formatValue(v, f)}</span>
            {pii && onReveal && shown === null && (
              <Button size="sm" variant="ghost" icon="eye" onClick={() => onReveal([pii])}>{t('card.reveal')}</Button>
            )}
          </div>
        );
      })}
      {nested.map(([k, v]) => {
        // Плоский объект примитивов (сводки «сколько чего») — чипами, остальное — JSON
        const flat = !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((x) => x === null || typeof x !== 'object');
        return (
          <div key={k} style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="label-caps" style={{ minWidth: '9rem' }}>{(t.has(`fields.${k}`) ? t(`fields.${k}`) : k)}</span>
            {flat ? (
              <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                {Object.entries(v as Record<string, unknown>).map(([kk, vv]) => (
                  <Chip key={kk} tone="neutral" size="sm">{`${t.has(`fields.${kk}`) ? t(`fields.${kk}`) : kk}: ${formatValue(vv, f)}`}</Chip>
                ))}
              </span>
            ) : (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify(v, null, 1)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatValue(v: unknown, f: ReturnType<typeof useFormatters>): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (typeof v === 'number') return f.number(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return f.dateTime(v);
  return String(v);
}
