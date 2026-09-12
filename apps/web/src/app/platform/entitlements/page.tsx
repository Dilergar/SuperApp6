'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  ENTITLEMENT_REGISTRY,
  entitlementKeysFor,
  parsePlatformQuery,
  type EntitlementKey,
  type EntitlementSubjectType,
  type EntitlementValue,
  type PlanDto,
  type PlanVersionDto,
  type PlatformCommandDto,
  type PlatformLookupHitDto,
} from '@superapp/shared';
import { Alert, BentoGrid, Button, Card, CardHeader, Chip, Input, LoadingBlock, PageHeader, SearchField, Table, TableCell, TableRow, Tabs, Toggle, type Tone } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import {
  fetchPlatformCatalog,
  fetchPlatformCommands,
  fetchPlatformLookup,
  fetchPlatformSubject,
  platformCatalogKey,
  platformCommandsKey,
  platformLookupKey,
  platformSubjectKey,
} from '@/lib/platform/api';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { useBytes, useFormatters } from '@/lib/format';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { SubjectEntitlements } from '@/components/platform/SubjectEntitlements';

// ============================================================
// «Тарифы»: Каталог (планы → версии чипами → таблица ключей; черновик правится
// инлайн, опубликованная — только чтение; колонка «изменение» относительно предыдущей
// опубликованной) и Субъекты (поиск → карточка: подписка, гранты, оверрайды, счётчики,
// «как видит клиент»; действия — команды реестра через CommandRunner).
// ============================================================

const VERSION_TONE: Record<PlanVersionDto['status'], Tone> = { draft: 'warning', published: 'success', archived: 'neutral' };
type Draft = Partial<Record<EntitlementKey, EntitlementValue>>;

export default function PlatformEntitlementsPage() {
  const t = useTranslations('platform');
  const [tab, setTab] = useState<'catalog' | 'subjects'>('catalog');
  return (
    <>
      <PageHeader breadcrumb={t('shell.title')} title={t('nav.entitlements')} description={t('catalog.description')} />
      <div style={{ marginBottom: 'var(--spacing-5)' }}>
        <Tabs<'catalog' | 'subjects'>
          value={tab}
          onChange={setTab}
          items={[
            { key: 'catalog', label: t('catalog.tab'), icon: 'crown' },
            { key: 'subjects', label: t('subject.tab'), icon: 'people' },
          ]}
          aria-label={t('nav.entitlements')}
        />
      </div>
      {tab === 'catalog' ? <CatalogTab /> : <SubjectsTab />}
    </>
  );
}

// ---------------- Каталог ----------------

function CatalogTab() {
  const t = useTranslations('platform');
  const te = useTranslations('entitlements');
  const tc = useTranslations('common');
  const f = useFormatters();
  const bytes = useBytes();
  const { can } = usePlatformAuth();
  const catalogQ = useQuery({ queryKey: platformCatalogKey, queryFn: fetchPlatformCatalog });
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const [selected, setSelected] = useState<{ planId: string; versionId: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const cmd = (key: string) => commandsQ.data?.find((c) => c.key === key) ?? null;
  const canWrite = can('entitlements.catalog.write');

  const plan: PlanDto | null = useMemo(() => catalogQ.data?.plans.find((p) => p.id === selected?.planId) ?? null, [catalogQ.data, selected]);
  const version: PlanVersionDto | null = useMemo(() => plan?.versions.find((v) => v.id === selected?.versionId) ?? null, [plan, selected]);
  const previousPublished: PlanVersionDto | null = useMemo(
    () => (plan && version ? plan.versions.filter((v) => v.status === 'published' && v.version < version.version).sort((a, b) => b.version - a.version)[0] ?? null : null),
    [plan, version],
  );
  useEffect(() => setDraft(version ? { ...version.entitlements } : {}), [version]);

  const keys: EntitlementKey[] = plan ? entitlementKeysFor(plan.subjectType) : [];
  const freeOf = (key: EntitlementKey): EntitlementValue => (plan ? (catalogQ.data?.freeValues[plan.subjectType]?.[key] ?? null) : null);
  const fmtValue = (key: EntitlementKey, v: EntitlementValue | undefined): string => {
    if (v === undefined) return t('catalog.inherits');
    if (v === null) return te('page.unlimited');
    if (typeof v === 'boolean') return v ? te('page.available') : te('page.unavailable');
    return ENTITLEMENT_REGISTRY[key].unit === 'bytes' ? bytes(v) : f.number(v);
  };
  const editable = !!version && version.status === 'draft' && canWrite;
  const dirty = !!version && JSON.stringify(draft) !== JSON.stringify(version.entitlements);

  if (catalogQ.isPending) return <LoadingBlock />;
  if (catalogQ.isError || !catalogQ.data) return <Alert tone="danger">{tc('state.error')}</Alert>;

  return (
    <BentoGrid>
      <Card span={5}>
        <CardHeader title={t('catalog.plans')} />
        <Table
          columns={[
            { key: 'plan', label: t('catalog.col.plan') },
            { key: 'subject', label: t('catalog.col.subject'), width: 'max-content' },
            { key: 'versions', label: t('catalog.col.versions') },
          ]}
          lines
          aria-label={t('catalog.plans')}
        >
          {catalogQ.data.plans.map((p, i) => (
            <TableRow key={p.id} rowIndex={i + 1} selected={p.id === selected?.planId}>
              <TableCell><span className="body-sm" style={{ fontWeight: 600 }}>{te(`plans.${p.key}`)}</span></TableCell>
              <TableCell><Chip tone="neutral" size="sm">{t(`subjectTypes.${p.subjectType}`)}</Chip></TableCell>
              <TableCell>
                <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                  {p.versions.map((v) => (
                    <Chip key={v.id} tone={VERSION_TONE[v.status]} size="sm" selected={v.id === selected?.versionId} onClick={() => setSelected({ planId: p.id, versionId: v.id })}>
                      v{v.version} · {t(`versionStatus.${v.status}`)}
                    </Chip>
                  ))}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </Card>

      <Card span={7}>
        {!plan || !version ? (
          <p className="label-sm">{t('catalog.pickVersion')}</p>
        ) : (
          <>
            <CardHeader
              title={`${te(`plans.${plan.key}`)} · v${version.version}`}
              subtitle={
                <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip tone={VERSION_TONE[version.status]} size="sm">{t(`versionStatus.${version.status}`)}</Chip>
                  {version.publishedAt && <span className="label-sm">{t('catalog.publishedAt', { date: f.date(version.publishedAt) })}</span>}
                  {version.note && <span className="label-sm">{version.note}</span>}
                </span>
              }
              actions={
                canWrite ? (
                  <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                    {cmd('entitlements.plan.createVersion') && (
                      <Button size="sm" variant="outline" icon="add" onClick={() => setRunner({ command: cmd('entitlements.plan.createVersion')!, input: { planKey: plan.key } })}>
                        {t('catalog.newDraft')}
                      </Button>
                    )}
                    {editable && cmd('entitlements.plan.updateDraft') && (
                      <Button size="sm" variant="primary" icon="save" disabled={!dirty} onClick={() => setRunner({ command: cmd('entitlements.plan.updateDraft')!, input: { planVersionId: version.id, entitlements: draft } })}>
                        {tc('actions.save')}
                      </Button>
                    )}
                    {version.status === 'draft' && cmd('entitlements.plan.publishVersion') && (
                      <Button size="sm" variant="primary" tone="success" icon="check" disabled={dirty} onClick={() => setRunner({ command: cmd('entitlements.plan.publishVersion')!, input: { planVersionId: version.id } })}>
                        {t('catalog.publish')}
                      </Button>
                    )}
                    {version.status === 'published' && cmd('entitlements.plan.archiveVersion') && (
                      <Button size="sm" variant="matte" tone="danger" icon="archive" onClick={() => setRunner({ command: cmd('entitlements.plan.archiveVersion')!, input: { planVersionId: version.id } })}>
                        {t('catalog.archive')}
                      </Button>
                    )}
                  </span>
                ) : undefined
              }
            />
            <Table
              columns={[
                { key: 'key', label: t('subject.col.key') },
                { key: 'value', label: t('subject.col.value') },
                { key: 'free', label: t('catalog.col.free'), width: 'max-content', hideOnMobile: true },
                { key: 'diff', label: t('catalog.col.diff'), width: 'max-content', hideOnMobile: true },
              ]}
              lines
              aria-label={t('catalog.keys')}
            >
              {keys.map((key, i) => {
                const def = ENTITLEMENT_REGISTRY[key];
                const cur = editable ? draft[key] : version.entitlements[key];
                const prev = previousPublished ? previousPublished.entitlements[key] : undefined;
                const changed = previousPublished !== null && JSON.stringify(prev ?? null) !== JSON.stringify(version.entitlements[key] ?? null);
                return (
                  <TableRow key={key} rowIndex={i + 1}>
                    <TableCell>
                      <span className="body-sm">{te(def.labelKey.replace(/^entitlements\./, ''))}</span>
                      <span className="label-sm" style={{ marginLeft: '0.375rem' }}>{te(`services.${def.service}`)}</span>
                    </TableCell>
                    <TableCell>
                      {editable ? (
                        <DraftValueEditor keyName={key} value={cur} onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))} onInherit={() => setDraft((d) => { const n = { ...d }; delete n[key]; return n; })} />
                      ) : (
                        <span className="body-sm">{fmtValue(key, cur)}</span>
                      )}
                    </TableCell>
                    <TableCell hideOnMobile><span className="label-sm">{fmtValue(key, freeOf(key))}</span></TableCell>
                    <TableCell hideOnMobile>{changed ? <Chip tone="accent" size="sm">{t('catalog.was', { value: fmtValue(key, prev) })}</Chip> : <span className="label-sm">—</span>}</TableCell>
                  </TableRow>
                );
              })}
            </Table>
          </>
        )}
      </Card>
      {runner && <CommandRunner command={runner.command} initialInput={runner.input} open onClose={() => setRunner(null)} />}
    </BentoGrid>
  );
}

function DraftValueEditor({ keyName, value, onChange, onInherit }: { keyName: EntitlementKey; value: EntitlementValue | undefined; onChange: (v: EntitlementValue) => void; onInherit: () => void }) {
  const t = useTranslations('platform');
  const te = useTranslations('entitlements');
  const bytes = useBytes();
  const def = ENTITLEMENT_REGISTRY[keyName];
  if (def.kind === 'feature') {
    return (
      <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <Toggle checked={value === true} onChange={(v) => onChange(v)} label={value === undefined ? t('catalog.inherits') : undefined} />
        {value !== undefined && <Button size="sm" variant="ghost" onClick={onInherit}>{t('catalog.inherit')}</Button>}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <Input
        type="number"
        min={0}
        value={typeof value === 'number' ? String(value) : ''}
        placeholder={value === null ? te('page.unlimited') : value === undefined ? t('catalog.inherits') : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        wrapClassName=""
        style={{ width: '9rem' }}
      />
      {def.unit === 'bytes' && typeof value === 'number' && <span className="label-sm">{bytes(value)}</span>}
      <Chip tone={value === null ? 'accent' : 'neutral'} size="sm" selected={value === null} onClick={() => onChange(null)}>{te('page.unlimited')}</Chip>
      {value !== undefined && <Button size="sm" variant="ghost" onClick={onInherit}>{t('catalog.inherit')}</Button>}
    </span>
  );
}

// ---------------- Субъекты ----------------

function SubjectsTab() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const { can, me } = usePlatformAuth();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ type: EntitlementSubjectType; id: string; label: string } | null>(null);
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const parsed = useMemo(() => parsePlatformQuery(q), [q]);
  const active = parsed.kind !== 'empty' && parsed.kind !== 'tooShort';
  const lookupQ = useQuery({ queryKey: platformLookupKey(q), queryFn: () => fetchPlatformLookup(q), enabled: active && !picked, retry: false });
  const detailQ = useQuery({ queryKey: picked ? platformSubjectKey(picked.type, picked.id) : ['platform', 'subject', 'none'], queryFn: () => fetchPlatformSubject(picked!.type, picked!.id), enabled: !!picked });
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const cmd = (key: string) => commandsQ.data?.find((c) => c.key === key) ?? null;
  const viaApproval = (c: PlatformCommandDto) => !!c.dualControl && !!me?.policy.dualControlEnabled;

  const pick = (hit: PlatformLookupHitDto) => setPicked({ type: hit.entity, id: hit.id, label: hit.entity === 'user' ? `${hit.person.firstName} ${hit.person.lastName ?? ''}`.trim() : hit.name });
  const subjectInput = picked ? { subject: { type: picked.type, id: picked.id } } : {};
  const ACTIONS: { key: string; label: string; tone?: 'danger' }[] = [
    { key: 'entitlements.subscription.set', label: t('commands.entitlementsSubscriptionSet.title') },
    { key: 'entitlements.trial.extend', label: t('commands.entitlementsTrialExtend.title') },
    { key: 'entitlements.grant.create', label: t('commands.entitlementsGrantCreate.title') },
    { key: 'entitlements.override.set', label: t('commands.entitlementsOverrideSet.title') },
    { key: 'entitlements.override.clear', label: t('commands.entitlementsOverrideClear.title'), tone: 'danger' },
  ];

  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader title={t('subject.find')} subtitle={t('search.description')} />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchField width={360} value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} onClear={() => { setQ(''); setPicked(null); }} placeholder={t('subject.placeholder')} aria-label={t('subject.find')} />
          {q && <Chip tone={active ? 'accent' : 'warning'} size="sm">{t(`search.kind.${parsed.kind}`)}</Chip>}
          {picked && <Chip tone="success" size="sm" onRemove={() => setPicked(null)}>{picked.label}</Chip>}
        </div>
        {!picked && lookupQ.data && (
          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginTop: 'var(--spacing-3)' }}>
            {[...lookupQ.data.users, ...lookupQ.data.workspaces].map((hit) => (
              <button
                key={`${hit.entity}:${hit.id}`}
                type="button"
                aria-label={hit.entity === 'user' ? `${hit.person.firstName} ${hit.person.lastName ?? ''}`.trim() : hit.name}
                onClick={() => pick(hit)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.625rem', borderRadius: 'var(--radius-pill)', border: '1px solid var(--divider)', background: 'transparent', cursor: 'pointer' }}
              >
                {hit.entity === 'user' && <PersonAvatar userId={hit.id} name={`${hit.person.firstName} ${hit.person.lastName ?? ''}`.trim()} avatar={hit.person.avatar} size="sm" />}
                <span className="body-sm">{hit.entity === 'user' ? `${hit.person.firstName} ${hit.person.lastName ?? ''}`.trim() : hit.name}</span>
                <span className="label-sm">{t(hit.entity === 'user' ? 'card.user' : 'card.workspace')}</span>
              </button>
            ))}
            {lookupQ.data.users.length + lookupQ.data.workspaces.length === 0 && <span className="label-sm">{t('search.noResults')}</span>}
          </div>
        )}
      </Card>
      {picked && (
        <Card span={12}>
          <CardHeader
            title={picked.label}
            subtitle={t(`subjectTypes.${picked.type}`)}
            actions={
              can('entitlements.subject.write') || can('entitlements.grant.write') || can('entitlements.override.write') ? (
                <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                  {ACTIONS.filter((a) => cmd(a.key)).map((a) => {
                    const c = cmd(a.key)!;
                    return (
                      <Button key={a.key} size="sm" variant={a.tone === 'danger' ? 'matte' : 'outline'} tone={a.tone} onClick={() => setRunner({ command: c, input: subjectInput })}>
                        {a.label}{viaApproval(c) ? ` · ${t('runner.viaApproval')}` : ''}
                      </Button>
                    );
                  })}
                </span>
              ) : undefined
            }
          />
          {detailQ.isPending ? <LoadingBlock /> : detailQ.isError || !detailQ.data ? <Alert tone="danger">{tc('state.error')}</Alert> : <SubjectEntitlements detail={detailQ.data} />}
        </Card>
      )}
      {runner && <CommandRunner command={runner.command} initialInput={runner.input} open onClose={() => setRunner(null)} />}
    </BentoGrid>
  );
}
