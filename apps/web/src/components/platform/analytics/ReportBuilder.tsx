'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { apiErrorMessage } from '@superapp/api-client';
import {
  ANALYTICS_LIMITS,
  ANALYTICS_TREND_METRICS,
  analyticsQuerySchema,
  type AnalyticsQueryInput,
  type AnalyticsReportDto,
  type AnalyticsTrendMetric,
  type AnalyticsViz,
} from '@superapp/shared';
import {
  Alert,
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Toggle,
  useConfirm,
  type IconName,
} from '@/components/ui';
import {
  analyticsDashboardKey,
  analyticsDashboardsKey,
  analyticsEventsKey,
  analyticsQueryKey,
  analyticsReportKey,
  analyticsReportsKey,
  createAnalyticsReport,
  deleteAnalyticsReport,
  fetchAnalyticsDashboard,
  fetchAnalyticsDashboards,
  fetchAnalyticsEvents,
  fetchAnalyticsReport,
  runAnalyticsQuery,
  updateAnalyticsDashboard,
  updateAnalyticsReport,
} from '@/lib/platform/analytics';
import { toast, toastError } from '@/lib/toast';
import { dashboardTitle } from './DashboardView';
import { EventPicker } from './EventPicker';
import { ReportViz, defaultViz } from './ReportViz';
import { reportTitle } from './ReportTile';
import { useAnalyticsParams } from './useAnalyticsParams';
import { useAnalyticsText } from './useAnalyticsText';

type Question = 'trend' | 'funnel' | 'retention' | 'services';

const QUESTIONS: Array<{ key: Question; icon: IconName }> = [
  { key: 'trend', icon: 'people' },
  { key: 'funnel', icon: 'filter' },
  { key: 'retention', icon: 'replay' },
  { key: 'services', icon: 'apps' },
];

const questionOf = (q: AnalyticsQueryInput): Question =>
  q.type === 'trend' ? 'trend' : q.type === 'funnel' ? 'funnel' : q.type === 'retention' ? 'retention' : 'services';

const base = (range: AnalyticsQueryInput['range']) => ({ range, compare: false, filters: {}, excludeInternal: true });

function template(question: Question, range: AnalyticsQueryInput['range']): AnalyticsQueryInput {
  switch (question) {
    case 'trend':
      return { type: 'trend', ...base(range), metric: 'dau', interval: 'day' };
    case 'funnel':
      return { type: 'funnel', ...base(range), steps: [{ eventKey: 'auth.registration.opened' }, { eventKey: 'auth.user.registered' }], windowDays: 7, mode: 'ordered', unit: 'user' };
    case 'retention':
      return { type: 'retention', ...base(range), mode: 'n_day', days: 28, unit: 'user' };
    default:
      return { type: 'adoption', ...base(range), unit: 'user', byPlan: false };
  }
}

const WINDOWS = ['1', '7', '30', '90'] as const;

/** Разбиения тренда; у метрик сессий роллап сквозной — только платформа и организация. */
const TREND_BREAKDOWNS = ['service', 'plan', 'platform', 'workspace'] as const;
const SESSION_BREAKDOWNS = ['platform', 'workspace'] as const;
const isSessionMetric = (m: AnalyticsTrendMetric) => m === 'sessions' || m === 'session_p50';
const breakdownsFor = (m: AnalyticsTrendMetric): ReadonlyArray<(typeof TREND_BREAKDOWNS)[number]> => (isSessionMetric(m) ? SESSION_BREAKDOWNS : TREND_BREAKDOWNS);

/**
 * Конструктор отчёта — от ВОПРОСА, а не от типа запроса: «Сколько людей…?» · «Где
 * отваливаются…?» · «Возвращаются ли…?» · «Какие сервисы…?». Слева форма (вопрос →
 * события → уточнение → сохранение), справа живой предпросмотр тем же компонентом,
 * что и плитка (задержка 400 мс). Системный или чужой отчёт сохраняется копией.
 */
export function ReportBuilder({ reportId }: { reportId?: string }) {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  const text = useAnalyticsText();
  const params = useAnalyticsParams();
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  const events = useQuery({ queryKey: analyticsEventsKey, queryFn: fetchAnalyticsEvents });
  const existing = useQuery({ queryKey: analyticsReportKey(reportId ?? ''), queryFn: () => fetchAnalyticsReport(reportId!), enabled: !!reportId });
  const dashboards = useQuery({ queryKey: analyticsDashboardsKey, queryFn: fetchAnalyticsDashboards });

  const [draft, setDraft] = useState<AnalyticsQueryInput | null>(null);
  const [viz, setViz] = useState<AnalyticsViz | null>(null);
  const [title, setTitle] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<null | 'save' | 'dashboard'>(null);
  const [targetDashboard, setTargetDashboard] = useState<string | null>(sp?.get('dashboard') ?? null);

  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    setDraft(r.query);
    setViz(r.viz);
    setTitle(r.canEdit ? reportTitle(r, t) : t('builder.copyOf', { name: reportTitle(r, t) }));
    setPrivate(r.visibility === 'private');
  }, [existing.data, t]);

  // Уход с несохранёнными изменениями: закрытие вкладки спрашивает браузер
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const change = (next: AnalyticsQueryInput) => {
    setDraft(next);
    setDirty(true);
  };
  const patch = <T extends AnalyticsQueryInput>(p: Partial<T>) => draft && change({ ...draft, ...p } as AnalyticsQueryInput);

  // Предпросмотр — с задержкой 400 мс и тем же состоянием панели управления, что у дашборда
  const [debounced, setDebounced] = useState<AnalyticsQueryInput | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(draft), 400);
    return () => clearTimeout(id);
  }, [draft]);
  const applied = useMemo(() => (debounced ? params.apply(debounced) : null), [debounced, params]);
  const valid = !!applied && analyticsQuerySchema.safeParse(applied).success;
  const preview = useQuery({
    queryKey: analyticsQueryKey(applied ?? ({} as AnalyticsQueryInput)),
    queryFn: () => runAnalyticsQuery(applied!),
    enabled: valid,
    placeholderData: keepPreviousData,
    refetchInterval: (state) => (state.state.data?.status === 'pending' ? 4000 : false),
  });

  const effectiveViz: AnalyticsViz | null = draft ? (viz ?? defaultViz(draft)) : null;
  const canOverwrite = !!existing.data?.canEdit;
  const editableDashboards = (dashboards.data ?? []).filter((d) => d.canEdit);

  const save = useMutation({
    mutationFn: async (addToDashboard: boolean) => {
      if (!draft) throw new Error('empty draft');
      const input = { title: title.trim(), query: draft, viz: effectiveViz ?? undefined, visibility: isPrivate ? ('private' as const) : ('shared' as const) };
      const report: AnalyticsReportDto = canOverwrite && reportId ? await updateAnalyticsReport(reportId, input) : await createAnalyticsReport(input);
      if (addToDashboard && targetDashboard) {
        const board = await fetchAnalyticsDashboard(targetDashboard);
        await updateAnalyticsDashboard(board.id, { tiles: [...board.tiles, { reportId: report.id, span: 6 }] });
        void qc.invalidateQueries({ queryKey: analyticsDashboardKey(targetDashboard) });
        return { report, dashboardId: board.id };
      }
      return { report, dashboardId: null };
    },
    onSuccess: ({ report, dashboardId }) => {
      setDirty(false);
      setSaving(null);
      void qc.invalidateQueries({ queryKey: analyticsReportsKey });
      void qc.invalidateQueries({ queryKey: analyticsDashboardsKey });
      toast(t('builder.saved'), 'success');
      router.push(params.href(dashboardId ? `/platform/analytics/d/${dashboardId}` : `/platform/analytics/reports/${report.id}`));
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const leave = () => {
    const go = () => router.push(params.href('/platform/analytics/reports'));
    if (!dirty) return go();
    confirm({ title: t('builder.unsavedTitle'), message: t('builder.unsavedText'), danger: true }, go);
  };
  const remove = () =>
    confirm({ title: t('builder.deleteTitle'), message: t('builder.deleteText'), danger: true }, async () => {
      try {
        await deleteAnalyticsReport(reportId!);
        setDirty(false);
        void qc.invalidateQueries({ queryKey: analyticsReportsKey });
        router.push(params.href('/platform/analytics/reports'));
      } catch (e) {
        toastError(apiErrorMessage(e));
      }
    });

  if (reportId && existing.isPending) return <LoadingBlock />;
  if (reportId && existing.isError) return <Alert tone="danger">{t('builder.notFound')}</Alert>;

  const evs = events.data ?? [];
  const section = (n: number, label: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 'var(--spacing-5) 0 var(--spacing-3)' }}>
      <Chip size="sm" tone="accent">{String(n)}</Chip>
      <span className="title-sm">{label}</span>
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
        <Button size="sm" variant="ghost" icon="arrowLeft" onClick={leave}>{t('builder.back')}</Button>
        {existing.data?.systemKey && <Chip size="sm" tone="neutral">{t('dashboards.system')}</Chip>}
        {existing.data && !existing.data.canEdit && <Chip size="sm" tone="neutral" icon="copy">{t('builder.willCopy')}</Chip>}
        {dirty && <Chip size="sm" tone="waiting">{t('builder.unsaved')}</Chip>}
        {canOverwrite && reportId && (
          <span style={{ marginInlineStart: 'auto' }}>
            <Button size="sm" variant="matte" tone="danger" icon="delete" onClick={remove}>{t('builder.delete')}</Button>
          </span>
        )}
      </div>
      <BentoGrid>
        <Card span={5}>
          {section(1, t('builder.steps.question'))}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))', gap: '0.5rem' }}>
            {QUESTIONS.map((q) => {
              const selected = draft ? questionOf(draft) === q.key : false;
              return (
                <Button
                  key={q.key}
                  variant={selected ? 'primary' : 'matte'}
                  tone="accent"
                  icon={q.icon}
                  block
                  aria-pressed={selected}
                  style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'start', height: 'auto', minHeight: '3.25rem' }}
                  onClick={() => {
                    if (selected) return;
                    change(template(q.key, params.range));
                    setViz(null);
                  }}
                >
                  {t(`questions.${q.key}`)}
                </Button>
              );
            })}
          </div>

          {draft && (
            <>
              {section(2, t('builder.steps.events'))}
              {draft.type === 'trend' && (
                <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
                  <Select<AnalyticsTrendMetric>
                    label={t('builder.metric')}
                    value={draft.metric}
                    onChange={(metric) =>
                      patch({
                        metric,
                        eventKey: metric === 'events' || metric === 'event_users' ? draft.eventKey : undefined,
                        // Разбиение, которого у новой метрики нет, — снять, а не отправить впустую
                        breakdown: draft.breakdown && (breakdownsFor(metric) as readonly string[]).includes(draft.breakdown) ? draft.breakdown : undefined,
                      })
                    }
                    options={ANALYTICS_TREND_METRICS.map((m) => ({ value: m, label: text.metric(m) }))}
                  />
                  {(draft.metric === 'events' || draft.metric === 'event_users') && (
                    <EventPicker
                      label={t('builder.event')}
                      value={draft.eventKey ?? null}
                      events={evs}
                      anyLabel={draft.metric === 'events' ? t('builder.allEvents') : undefined}
                      onChange={(key) => patch({ eventKey: (key ?? undefined) as never })}
                    />
                  )}
                </div>
              )}
              {draft.type === 'funnel' && (
                <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
                  {draft.steps.map((step, i) => {
                    const alternatives = step.orEventKeys ?? [];
                    // Свойство — часть схемы ОДНОГО события: у шага «любое из» фильтра нет
                    const enumProps = alternatives.length ? [] : (evs.find((e) => e.key === step.eventKey)?.enumProps ?? []);
                    type StepKey = typeof step.eventKey;
                    const withAlternatives = (next: StepKey[]) => (next.length ? { eventKey: step.eventKey, orEventKeys: next } : { eventKey: step.eventKey });
                    const setStep = (next: typeof step | null) => {
                      const steps = [...draft.steps];
                      if (next) steps[i] = next;
                      else steps.splice(i, 1);
                      patch({ steps });
                    };
                    const swap = (j: number) => {
                      if (j < 0 || j >= draft.steps.length) return;
                      const steps = [...draft.steps];
                      [steps[i], steps[j]] = [steps[j], steps[i]];
                      patch({ steps });
                    };
                    return (
                      <div key={i} style={{ border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-3)' }} className="ui-stack">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <span className="label-caps" style={{ flex: 1 }}>{t('builder.stepN', { n: i + 1 })}</span>
                          <IconButton icon="arrowUp" label={t('builder.moveUp')} size={28} disabled={i === 0} onClick={() => swap(i - 1)} />
                          <IconButton icon="arrowDown" label={t('builder.moveDown')} size={28} disabled={i === draft.steps.length - 1} onClick={() => swap(i + 1)} />
                          <IconButton icon="delete" label={t('builder.removeStep')} size={28} disabled={draft.steps.length <= 2} onClick={() => setStep(null)} />
                        </div>
                        <EventPicker
                          label={t('builder.event')}
                          value={step.eventKey}
                          events={evs}
                          exclude={alternatives}
                          onChange={(key) => key && setStep(alternatives.length ? { eventKey: key as StepKey, orEventKeys: alternatives } : { eventKey: key as StepKey })}
                        />
                        {alternatives.map((alt) => (
                          <div key={alt} style={{ display: 'flex', alignItems: 'flex-end', gap: '0.25rem' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <EventPicker
                                label={t('builder.orLabel')}
                                value={alt}
                                events={evs}
                                exclude={[step.eventKey, ...alternatives.filter((a) => a !== alt)]}
                                onChange={(key) => key && setStep(withAlternatives(alternatives.map((a) => (a === alt ? (key as StepKey) : a))))}
                              />
                            </div>
                            <IconButton icon="delete" label={t('builder.removeAlternative')} size={28} onClick={() => setStep(withAlternatives(alternatives.filter((a) => a !== alt)))} />
                          </div>
                        ))}
                        {!step.where && alternatives.length < ANALYTICS_LIMITS.maxFunnelStepAlternatives && (
                          <EventPicker
                            label={t('builder.orEvent')}
                            addLabel={t('builder.orEvent')}
                            value={null}
                            events={evs}
                            exclude={[step.eventKey, ...alternatives]}
                            onChange={(key) => key && setStep(withAlternatives([...alternatives, key as StepKey]))}
                          />
                        )}
                        {enumProps.length > 0 && (
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <Select<string>
                              width="12rem"
                              label={t('builder.stepFilter')}
                              value={step.where?.prop ?? ''}
                              onChange={(prop) => setStep(prop ? { eventKey: step.eventKey, where: { prop, value: enumProps.find((p) => p.prop === prop)!.values[0] } } : { eventKey: step.eventKey })}
                              options={[{ value: '', label: t('builder.anyValue') }, ...enumProps.map((p) => ({ value: p.prop, label: t.has(`props.${p.prop}`) ? t(`props.${p.prop}`) : p.prop }))]}
                            />
                            {step.where && (
                              <Select<string>
                                width="10rem"
                                label={t('builder.value')}
                                value={step.where.value}
                                onChange={(value) => setStep({ eventKey: step.eventKey, where: { prop: step.where!.prop, value } })}
                                options={(enumProps.find((p) => p.prop === step.where!.prop)?.values ?? []).map((v) => ({ value: v, label: t.has(`propValues.${v}`) ? t(`propValues.${v}`) : v }))}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {draft.steps.length < 8 && (
                    <div>
                      <Button size="sm" variant="outline" icon="add" onClick={() => patch({ steps: [...draft.steps, { eventKey: draft.steps[draft.steps.length - 1].eventKey }] })}>
                        {t('builder.addStep')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {draft.type === 'retention' && (
                <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
                  <EventPicker label={t('builder.startEvent')} value={draft.startEvent ?? null} events={evs} anyLabel={t('builder.anyActivity')} onChange={(key) => patch({ startEvent: (key ?? undefined) as never })} />
                  <EventPicker label={t('builder.returnEvent')} value={draft.returnEvent ?? null} events={evs} anyLabel={t('builder.anyActivity')} onChange={(key) => patch({ returnEvent: (key ?? undefined) as never })} />
                </div>
              )}
              {(draft.type === 'adoption' || draft.type === 'journeys' || draft.type === 'lifecycle') && (
                <SegmentedControl<'adoption' | 'journeys' | 'lifecycle'>
                  value={draft.type}
                  onChange={(k) => {
                    const b = { range: draft.range, compare: draft.compare, filters: draft.filters, excludeInternal: draft.excludeInternal };
                    change(k === 'adoption' ? { type: 'adoption', ...b, unit: 'user', byPlan: false } : k === 'journeys' ? { type: 'journeys', ...b, limit: 10 } : { type: 'lifecycle', ...b, interval: 'week', unit: 'user' });
                    setViz(null);
                  }}
                  items={[
                    { key: 'adoption', label: t('types.adoption') },
                    { key: 'journeys', label: t('types.journeys') },
                    { key: 'lifecycle', label: t('types.lifecycle') },
                  ]}
                  aria-label={t('questions.services')}
                />
              )}

              {section(3, t('builder.steps.refine'))}
              <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
                {(draft.type === 'funnel' || draft.type === 'retention' || draft.type === 'adoption' || draft.type === 'lifecycle') && (
                  <SegmentedControl<'user' | 'workspace'>
                    value={draft.unit}
                    onChange={(unit) => patch({ unit, ...(draft.type === 'funnel' && unit === 'workspace' && draft.mode === 'strict' ? { mode: 'ordered' } : {}) } as never)}
                    items={[
                      { key: 'user', label: t('units.user') },
                      { key: 'workspace', label: t('units.workspace') },
                    ]}
                    aria-label={t('builder.unit')}
                  />
                )}
                {draft.type === 'trend' && (
                  <>
                    <Select<string>
                      label={t('builder.breakdown')}
                      value={draft.breakdown ?? ''}
                      onChange={(v) => patch({ breakdown: (v || undefined) as never })}
                      options={[{ value: '', label: t('builder.noBreakdown') }, ...breakdownsFor(draft.metric).map((b) => ({ value: b, label: t(`breakdown.${b}`) }))]}
                    />
                    {['events', 'event_users', 'new_users', 'sessions', 'session_p50'].includes(draft.metric) && (
                      <SegmentedControl<'day' | 'week' | 'month'>
                        value={draft.interval}
                        onChange={(interval) => patch({ interval })}
                        items={(['day', 'week', 'month'] as const).map((k) => ({ key: k, label: t(`intervals.${k}`) }))}
                        aria-label={t('builder.interval')}
                      />
                    )}
                    <SegmentedControl<AnalyticsViz>
                      value={effectiveViz ?? 'line'}
                      onChange={(v) => { setViz(v); setDirty(true); }}
                      items={(['line', 'bar', 'stat'] as const).map((k) => ({ key: k, label: t(`viz.${k}`) }))}
                      aria-label={t('builder.view')}
                    />
                  </>
                )}
                {draft.type === 'funnel' && (
                  <>
                    <SegmentedControl<(typeof WINDOWS)[number]>
                      value={(WINDOWS as readonly string[]).includes(String(draft.windowDays)) ? (String(draft.windowDays) as (typeof WINDOWS)[number]) : '7'}
                      onChange={(w) => patch({ windowDays: Number(w) })}
                      items={WINDOWS.map((w) => ({ key: w, label: t('builder.windowDays', { days: Number(w) }) }))}
                      aria-label={t('builder.window')}
                    />
                    <Select<string>
                      label={t('builder.mode')}
                      value={draft.mode}
                      onChange={(mode) => patch({ mode: mode as never })}
                      options={(draft.unit === 'workspace' ? (['ordered', 'any'] as const) : (['ordered', 'strict', 'any'] as const)).map((m) => ({ value: m, label: t(`funnelModes.${m}`) }))}
                    />
                    <Select<string>
                      label={t('builder.breakdown')}
                      value={draft.breakdown ?? ''}
                      onChange={(v) => patch({ breakdown: (v || undefined) as never })}
                      options={[{ value: '', label: t('builder.noBreakdown') }, { value: 'platform', label: t('breakdown.platform') }, { value: 'plan', label: t('breakdown.plan') }]}
                    />
                  </>
                )}
                {draft.type === 'retention' && (
                  <>
                    <SegmentedControl<'curve' | 'cohort'>
                      value={effectiveViz === 'cohort' ? 'cohort' : 'curve'}
                      onChange={(v) => { setViz(v); setDirty(true); }}
                      items={[
                        { key: 'curve', label: t('viz.curve') },
                        { key: 'cohort', label: t('viz.cohort') },
                      ]}
                      aria-label={t('builder.view')}
                    />
                    <Select<string>
                      label={t('builder.retentionMode')}
                      value={draft.mode}
                      onChange={(mode) => patch({ mode: mode as never })}
                      options={(['n_day', 'unbounded', 'bracket'] as const).map((m) => ({ value: m, label: t(`retentionModes.${m}`) }))}
                    />
                    <Select<string>
                      label={t('builder.days')}
                      value={String(draft.days)}
                      onChange={(v) => patch({ days: Number(v) })}
                      options={['7', '14', '28', '60', '90'].map((d) => ({ value: d, label: t('format.days', { value: d }) }))}
                    />
                  </>
                )}
                {draft.type === 'adoption' && (
                  <>
                    <Toggle checked={draft.byPlan} onChange={(byPlan) => { patch({ byPlan }); setViz(byPlan ? 'table' : null); }} label={t('builder.byPlan')} />
                    <SegmentedControl<AnalyticsViz>
                      value={effectiveViz ?? 'bar'}
                      onChange={(v) => { setViz(v); setDirty(true); }}
                      items={(draft.byPlan ? (['table', 'bar'] as const) : (['bar', 'scatter'] as const)).map((k) => ({ key: k, label: t(`viz.${k}`) }))}
                      aria-label={t('builder.view')}
                    />
                  </>
                )}
                {draft.type === 'lifecycle' && (
                  <SegmentedControl<'day' | 'week' | 'month'>
                    value={draft.interval}
                    onChange={(interval) => patch({ interval })}
                    items={(['day', 'week', 'month'] as const).map((k) => ({ key: k, label: t(`intervals.${k}`) }))}
                    aria-label={t('builder.interval')}
                  />
                )}
              </div>

              {section(4, t('builder.steps.save'))}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Button variant="primary" tone="success" icon="save" onClick={() => setSaving('save')}>{t('builder.save')}</Button>
                <Button variant="outline" icon="dashboard" onClick={() => setSaving('dashboard')}>{t('builder.saveAndAdd')}</Button>
              </div>
            </>
          )}
        </Card>

        <Card span={7}>
          <CardHeader title={t('builder.preview')} subtitle={draft ? title || text.queryType(draft.type) : undefined} />
          {!draft ? (
            <p className="body-sm">{t('builder.previewHint')}</p>
          ) : !valid ? (
            <p className="body-sm">{t('builder.previewIncomplete')}</p>
          ) : preview.isPending ? (
            <Skeleton height={220} />
          ) : preview.isError ? (
            <Alert tone="danger" action={<Button size="sm" variant="outline" icon="refresh" onClick={() => void preview.refetch()}>{tc('actions.retry')}</Button>}>
              {apiErrorMessage(preview.error)}
            </Alert>
          ) : preview.data && applied ? (
            <ReportViz response={preview.data} query={applied} viz={effectiveViz === 'stat' ? 'line' : (effectiveViz ?? 'line')} title={title || text.queryType(draft.type)} text={text} dimmed={preview.isFetching} />
          ) : null}
        </Card>
      </BentoGrid>

      <Modal
        open={saving !== null}
        onClose={() => setSaving(null)}
        title={saving === 'dashboard' ? t('builder.saveAndAdd') : t('builder.saveTitle')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaving(null)}>{tc('actions.cancel')}</Button>
            <Button
              variant="primary"
              tone="success"
              icon="check"
              loading={save.isPending}
              disabled={!title.trim() || (saving === 'dashboard' && !targetDashboard)}
              onClick={() => save.mutate(saving === 'dashboard')}
            >
              {tc('actions.save')}
            </Button>
          </>
        }
      >
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <Input label={t('builder.nameLabel')} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <Toggle checked={isPrivate} onChange={setPrivate} label={t('builder.private')} description={t('builder.privateHint')} />
          {saving === 'dashboard' && (
            <Select<string>
              label={t('builder.chooseDashboard')}
              value={targetDashboard}
              onChange={setTargetDashboard}
              placeholder={t('builder.chooseDashboard')}
              options={editableDashboards.map((d) => ({ value: d.id, label: dashboardTitle(d, t), icon: d.visibility === 'private' ? 'lock' : 'dashboard' }))}
            />
          )}
          {saving === 'dashboard' && isPrivate && editableDashboards.find((d) => d.id === targetDashboard)?.visibility === 'shared' && (
            <Alert tone="warning">{t('builder.privateOnShared')}</Alert>
          )}
        </div>
      </Modal>
      {confirmUI}
    </>
  );
}
