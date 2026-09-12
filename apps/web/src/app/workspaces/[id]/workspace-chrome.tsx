'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useEntitlements } from '@/lib/hooks/useEntitlements';
import { fetchWorkspaces, workspacesKey } from '@/lib/queries';
import { Chip } from '@/components/ui/Chip';

/**
 * Top-level chrome for the organization area (Главная организации, Сотрудники, Профиль).
 * Just the page container; the profile sub-area adds its own sidebar.
 * Mirrors how the personal /dashboard and /profile share the app shell.
 *
 * Клиентский — поэтому вынесен из `layout.tsx`: провайдер каталога
 * (`ServiceMessages`) обязан выполняться на СЕРВЕРЕ, и layout остаётся его
 * серверной обёрткой (тот же приём, что в `app/profile/`).
 *
 * Сигнал тарифа: владельцу и админам показывается чип состояния плана ТОЛЬКО когда
 * есть что сообщить (пробный · льготный период · истёк); в обычном состоянии чипа
 * нет, баннеров на Главной нет — не нагнетаем. Клик ведёт в «Тариф и лимиты».
 */
export function WorkspaceChrome({ children }: { children: React.ReactNode }) {
  const tc = useTranslations('common');
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>{tc('state.loading')}</p>
      </div>
    );
  }

  return (
    <div className="">
      <PlanSignal workspaceId={id} />
      <div className="" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {children}
      </div>
    </div>
  );
}

const DAY = 86_400_000;
const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / DAY));

function PlanSignal({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('entitlements');
  const { data: workspaces } = useQuery({ queryKey: workspacesKey, queryFn: fetchWorkspaces, staleTime: 60_000 });
  const role = workspaces?.find((w) => w.id === workspaceId)?.myRole ?? null;
  const manages = role === 'owner' || role === 'admin';
  const { data: snap } = useEntitlements(workspaceId, manages);
  if (!manages || !snap) return null;

  const sub = snap.subscription;
  let text: string | null = null;
  let tone: 'warning' | 'danger' = 'warning';
  if (sub?.status === 'trialing' && sub.trialEndsAt) text = t('chrome.trial', { days: daysLeft(sub.trialEndsAt) });
  else if (sub?.status === 'past_due' && sub.graceUntil) text = t('chrome.grace', { days: daysLeft(sub.graceUntil) });
  else if (!sub && snap.recentlyEnded) {
    text = t('chrome.expired');
    tone = 'danger';
  }
  if (!text) return null;

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 var(--spacing-6)', marginTop: 'var(--spacing-2)' }}>
      <Link href={`/workspaces/${workspaceId}/profile/subscription`} style={{ display: 'inline-flex' }} aria-label={t('chrome.link')}>
        <Chip tone={tone} icon="crown" size="sm">
          {text}
        </Chip>
      </Link>
    </div>
  );
}
