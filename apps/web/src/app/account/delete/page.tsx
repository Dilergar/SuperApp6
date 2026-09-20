'use client';

// ============================================================
// Мастер удаления аккаунта (= отзыв согласия на обработку ПДн, core/consents):
//   1. проверка — блокеры (мотивированный отказ, ЗоПД ст. 8 п. 7) показываются ДО пароля;
//   2. что произойдёт — отзыв согласия, 15 рабочих дней, грейс на восстановление, что останется;
//   3. подтверждение — пароль → SMS-код на свой номер (цель `account_delete`);
//   4. готово — «Аккаунт будет удалён DD.MM».
// ============================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { WORKSPACE_LIMITS, type AccountDeletionBlockersDto, type ConsentPendingDto, type WorkspaceMember } from '@superapp/shared';
import { Alert, Button, ConfirmDialog, Input, LoadingBlock } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { OtpStep } from '@/components/verify/OtpStep';
import { useOtpFlow } from '@/components/verify/otp-flow';
import { apiDelete, apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { accountDeletionBlockersKey, consentsPendingKey, workspaceMembersKey, workspacesKey } from '@/lib/queries';

import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { AuthLayout } from '../../auth-ui';

import { toastApiError } from '@/lib/api-errors';
type Step = 'check' | 'consequences' | 'confirm' | 'done';
const STEPS: Array<{ key: Step; labelKey: string }> = [
  { key: 'check', labelKey: 'deletion.steps.check' },
  { key: 'consequences', labelKey: 'deletion.steps.consequences' },
  { key: 'confirm', labelKey: 'deletion.steps.confirm' },
  { key: 'done', labelKey: 'deletion.steps.done' },
];

interface DeletionResult {
  scheduled: boolean;
  gracePeriodDays: number;
  purgeAt: string;
}

/**
 * Выход для единственного владельца — ПРЯМО В МАСТЕРЕ: передать владение или отправить организацию
 * в архив. Страницы организации за блокирующим экраном согласий недоступны, а человек, не
 * принимающий новые условия, обязан иметь возможность удалить аккаунт (отзыв согласия — его право).
 * Оба маршрута API и список сотрудников работают вне шлюза (`@SkipConsentGate`).
 */
function SoleOwnerActions({ workspace, gated, onDone }: { workspace: { id: string; name: string }; gated: boolean; onDone: () => void }) {
  const t = useTranslations('consents');
  const qc = useQueryClient();
  const [transferTo, setTransferTo] = useState('');
  const [confirm, setConfirm] = useState<null | 'transfer' | 'archive'>(null);
  const [busy, setBusy] = useState(false);

  const members = useQuery({
    queryKey: workspaceMembersKey(workspace.id),
    queryFn: async () => await apiGet<WorkspaceMember[]>(`/workspaces/${workspace.id}/members`),
  });
  const candidates = (members.data ?? []).filter((m) => m.role !== 'owner');

  const run = async () => {
    setBusy(true);
    try {
      if (confirm === 'transfer') await apiPost(`/workspaces/${workspace.id}/transfer`, { toUserId: transferTo });
      else await apiDelete(`/workspaces/${workspace.id}`);
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: workspacesKey });
      onDone();
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
      {candidates.length > 0 ? (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <EntitySelector
              types={['user']}
              options={candidates.map((m) => ({ type: 'user', id: m.userId, title: m.userName, firstName: m.userName }))}
              value={transferTo ? [{ type: 'user', id: transferTo }] : []}
              onChange={(next) => setTransferTo(next[next.length - 1]?.id ?? '')}
              placeholder={t('deletion.transferPick')}
            />
          </div>
          <Button size="sm" variant="outline" icon="crown" disabled={!transferTo || busy} onClick={() => setConfirm('transfer')}>{t('deletion.transfer')}</Button>
        </div>
      ) : (
        members.isSuccess && <p className="label-sm" style={{ margin: 0 }}>{t('deletion.noMembers')}</p>
      )}
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        <Button size="sm" variant="outline" tone="danger" icon="archive" disabled={busy} onClick={() => setConfirm('archive')}>{t('deletion.archive')}</Button>
        {/* За блокирующим экраном страница организации закрыта — ссылку на неё не показываем */}
        {!gated && <Button size="sm" variant="ghost" href={`/workspaces/${workspace.id}`}>{t('deletion.openOrganization')}</Button>}
      </div>
      <ConfirmDialog
        open={!!confirm}
        onClose={() => !busy && setConfirm(null)}
        onConfirm={run}
        title={confirm === 'transfer' ? t('deletion.transferConfirmTitle') : t('deletion.archiveConfirmTitle')}
        message={
          confirm === 'transfer'
            ? t('deletion.transferConfirmMessage', { name: workspace.name })
            : t('deletion.archiveConfirmMessage', { name: workspace.name, n: WORKSPACE_LIMITS.archiveRetentionDays })
        }
        confirmLabel={confirm === 'transfer' ? t('deletion.transfer') : t('deletion.archive')}
        danger
        loading={busy}
      />
    </div>
  );
}

export default function AccountDeletePage() {
  useRequireAuth();
  const t = useTranslations('consents');
  const common = useTranslations('common');
  const fmt = useFormatters();
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const flow = useOtpFlow();

  const [step, setStep] = useState<Step>('check');
  const [password, setPassword] = useState('');
  const [codeStage, setCodeStage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [purgeAt, setPurgeAt] = useState<string | null>(null);

  const blockers = useQuery({
    queryKey: accountDeletionBlockersKey,
    queryFn: () => apiGet<AccountDeletionBlockersDto>('/users/me/deletion-blockers'),
    staleTime: 0,
  });
  const state = blockers.data;
  // Человек за блокирующим экраном согласий: страницы организаций ему закрыты (кэш шлюза каркаса)
  const pending = useQuery({ queryKey: consentsPendingKey, queryFn: () => apiGet<ConsentPendingDto>('/consents/pending'), staleTime: 60_000 });
  const gated = (pending.data?.blocking.length ?? 0) > 0;

  // Блокеров нет — первый шаг проходится сам: человеку незачем нажимать «далее» на пустом экране
  useEffect(() => {
    if (step === 'check' && state?.canDelete) setStep('consequences');
  }, [step, state]);

  const finish = async (verifyToken?: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await apiDelete<DeletionResult>('/users/me', { data: { password, ...(verifyToken ? { verifyToken } : {}) } });
      setPurgeAt(res?.purgeAt ?? null);
      setStep('done');
      // Сессии уже погашены сервером — чистим локальное состояние, не уводя человека с экрана итога
      await logout();
    } catch (err) {
      setError(apiErrorMessage(err) || t('deletion.failed'));
      setCodeStage(false);
    } finally {
      setBusy(false);
    }
  };

  const startConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setError('');
    if (!state?.verifyRequired) {
      // Среда без SMS-подтверждения (development/test): пароля достаточно
      await finish();
      return;
    }
    setBusy(true);
    try {
      // Пароль проверяется сервером ДО отправки SMS — неверный пароль не сжигает код
      const ok = await flow.startStepUp('account_delete', password);
      if (ok) setCodeStage(true);
      else setError(flow.error || t('deletion.failed'));
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    const token = await flow.check(code);
    if (token) await finish(token);
  };

  const stepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <AuthLayout
      title={t('deletion.title')}
      step={{ current: stepIdx, total: STEPS.length, labels: STEPS.map((s) => t(s.labelKey)) }}
      footer={step !== 'done' ? <Link href="/profile/security" style={{ fontWeight: 700 }}>{common('actions.cancel')}</Link> : undefined}
    >
      {step === 'check' && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          {blockers.isLoading && <LoadingBlock text={t('deletion.checking')} />}
          {blockers.isError && <Alert tone="danger">{apiErrorMessage(blockers.error)}</Alert>}
          {state && !state.canDelete && (
            <>
              <Alert tone="warning" title={t('deletion.blockedTitle')}>{t('deletion.blockedText')}</Alert>
              <ul className="ui-stack" style={{ gap: 'var(--spacing-3)', listStyle: 'none', padding: 0, margin: 0 }}>
                {state.blockers.flatMap((b) =>
                  b.code === 'sole_owner'
                    ? (b.workspaces ?? []).map((w) => (
                        <li key={`${b.code}:${w.id}`} className="card" style={{ padding: 'var(--spacing-4)' }}>
                          <p style={{ margin: '0 0 var(--spacing-3)', fontSize: '0.875rem', lineHeight: 1.5 }}>{t('deletion.blockers.sole_owner', { name: w.name, members: w.members })}</p>
                          <SoleOwnerActions workspace={w} gated={gated} onDone={() => void blockers.refetch()} />
                        </li>
                      ))
                    : [
                        <li key={b.code} className="card" style={{ padding: 'var(--spacing-4)', fontSize: '0.875rem', lineHeight: 1.5 }}>
                          {t(`deletion.blockers.${b.code}`, { count: b.count ?? 0 })}
                        </li>,
                      ],
                )}
              </ul>
              <Button variant="outline" onClick={() => void blockers.refetch()} loading={blockers.isFetching}>{common('actions.retry')}</Button>
            </>
          )}
        </div>
      )}

      {step === 'consequences' && state && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: 'var(--spacing-3)', fontSize: '0.875rem', lineHeight: 1.55 }}>
            <li>{t('deletion.c.consent')}</li>
            <li>{t('deletion.c.grace', { days: state.graceDays })}</li>
            <li>{t('deletion.c.term')}</li>
            <li>{t('deletion.c.keys')}</li>
            <li>{t('deletion.c.remains')}</li>
          </ul>
          <Button variant="primary" tone="danger" size="lg" block onClick={() => setStep('confirm')}>{t('deletion.continue')}</Button>
        </div>
      )}

      {step === 'confirm' && !codeStage && (
        <form onSubmit={startConfirm} className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Input
            label={t('deletion.password')}
            type="password"
            icon="lock"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
          <Button type="submit" variant="primary" tone="danger" size="lg" block loading={busy} disabled={!password}>
            {state?.verifyRequired ? t('deletion.sendCode') : t('deletion.submitNoSms')}
          </Button>
        </form>
      )}

      {step === 'confirm' && codeStage && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
          {error && <Alert tone="danger">{error}</Alert>}
          <OtpStep flow={flow} onSubmit={(code) => void submitCode(code)} onBack={() => { flow.reset(); setCodeStage(false); }} title={t('deletion.codeHint')} />
        </div>
      )}

      {step === 'done' && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <Alert tone="success" title={purgeAt ? t('deletion.doneTitle', { date: fmt.date(purgeAt) }) : t('deletion.title')}>{t('deletion.doneText')}</Alert>
          <Button variant="primary" size="lg" block onClick={() => router.push('/login?deleted=1')}>{t('deletion.toLogin')}</Button>
        </div>
      )}
    </AuthLayout>
  );
}
