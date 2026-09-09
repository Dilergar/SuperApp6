'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useApprovalsCount } from '@/lib/hooks/useApprovalsCount';
import { apiGet } from '@/lib/api';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
import { useRoleLabel } from './members/members-lib';
import {
  WORKSPACE_ROLE_RANK,
  type Workspace,
  type WorkspaceRole,
} from '@superapp/shared';
import {
  BentoGrid, Button, Card, CardHeader, Chip, EmptyState, Icon, LoadingBlock, PageHeader, StatTile,
  type IconName,
} from '@/components/ui';
import { SubmitDocumentModal } from './documents/SubmitDocumentModal';

// Стопка тянет за собой список решений и карточки людей — на главной она нужна
// только по клику, поэтому грузится отдельным чанком (как на личной Главной).
const DecisionStack = dynamic(
  () => import('@/components/approvals/DecisionStack').then((m) => m.DecisionStack),
  { ssr: false },
);

// Имя ступени пропуска даёт каталог (`useRoleLabel`): реестр WORKSPACE_ROLES
// несёт права, а не слова.

interface ServiceCard {
  /** Ключ плитки — он же ключ каталога и React-ключ списка */
  key: string;
  title: string;
  desc: string;
  icon: IconName;
  href?: string;
}

/**
 * Главная организации — the org's home screen (mirror of the personal /dashboard,
 * but scoped to one organization). Header + services grid + stats. The org profile,
 * members, and future org-scoped services are reached from here.
 */
export default function WorkspaceHome() {
  const t = useTranslations('workspaces');
  const ta = useTranslations('approvals');
  const f = useFormatters();
  const roleLabel = useRoleLabel();
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  // Счётчик скоуплен ЭТОЙ организацией: на главной «Кофейни» не должны считаться
  // решения из «Пекарни» — иначе цифра ведёт в стопку, где половина не отсюда.
  const approvalsCount = useApprovalsCount(isReady, { workspaceId: id });

  useEffect(() => {
    if (!isReady) return;
    apiGet<Workspace>(`/workspaces/${id}`)
      .then(setWs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isReady, id]);

  if (loading) return <LoadingBlock />;
  if (!ws) {
    return (
      <>
        <PageHeader breadcrumb={t('orgFallback')} title={t('orgFallback')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="workspace"
              title={t('notOpened.title')}
              description={t('notOpened.descriptionGone')}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const rank = ws.myRole ? WORKSPACE_ROLE_RANK[ws.myRole as WorkspaceRole] ?? 0 : 0;

  // Плитка знает свой КЛЮЧ, слова к нему даёт каталог (`workspaces.home.service.*`).
  const card = (key: string, icon: IconName, href?: string): ServiceCard => ({
    key,
    title: t(`home.service.${key}.title`),
    desc: t(`home.service.${key}.desc`),
    icon,
    href,
  });

  const services: ServiceCard[] = [
    card('members', 'staff', `/workspaces/${id}/members`),
    card('documents', 'file', `/workspaces/${id}/documents`),
    card('counterparties', 'workspace', `/workspaces/${id}/counterparties`),
    card('processes', 'processes', `/workspaces/${id}/processes`),
    card('office', 'office', `/workspaces/${id}/office`),
    ...(ws.myRole === 'owner' ? [card('wallet', 'coins', `/workspaces/${id}/wallet`)] : []),
    ...(rank >= WORKSPACE_ROLE_RANK.manager
      ? [
          // КЭДО: сводный экран «что горит сегодня» — ЕСУТД, вручения, расчёты
          card('deadlines', 'clock', `/workspaces/${id}/members?tab=deadlines`),
          card('journal', 'journal', `/workspaces/${id}/journal`),
          // Раздать наружу может Менеджер+, значит и закрыть чужое вправе он —
          // иначе ссылки уволенного оставались бы без хозяина.
          card('links', 'link', `/workspaces/${id}/links`),
        ]
      : []),
    card('tasks', 'tasks'),
    card('calendar', 'calendar'),
  ];

  const created = f.date(ws.createdAt, 'long');

  return (
    <>
      <PageHeader
        breadcrumb={t('orgFallback')}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
            <span
              aria-hidden
              style={{
                width: 44,
                height: 44,
                flex: 'none',
                borderRadius: 'var(--radius-md)',
                background: ws.logo ? `center/cover no-repeat url(${ws.logo})` : 'var(--surface-container)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--muted)',
              }}
            >
              {!ws.logo && <Icon name="workspace" size={22} />}
            </span>
            {ws.name}
          </span>
        }
        chip={ws.myRole ? <Chip tone="accent" icon="user">{roleLabel(ws.myRole)}</Chip> : undefined}
        actions={
          // «Подать заявление» — на главной организации, а не на личной: здесь
          // контекст однозначен. На личной Главной пришлось бы сперва спрашивать,
          // в какую из организаций человек подаёт.
          <Button icon="add" onClick={() => setSubmitOpen(true)}>
            {t('home.submitDocument')}
          </Button>
        }
      />

      <BentoGrid>
        {/* ---------- Показатели ---------- */}
        <StatTile span={approvalsCount > 0 ? 3 : 4} label={t('home.stat.members')} value={ws.membersCount} icon="staff" tone="accent" href={`/workspaces/${id}/members`} />
        {/* Плитка решений появляется, ТОЛЬКО когда что-то действительно ждёт:
            строка «0» на главной — шум, а главная отвечает на один вопрос —
            «что требует меня прямо сейчас». Не ссылка: стопка разбирается
            модалкой, не уходя со страницы. */}
        {approvalsCount > 0 && (
          <StatTile
            span={3}
            label={ta('inboxTitle')}
            value={approvalsCount}
            icon="checkCircle"
            tone="accent"
            onClick={() => setStackOpen(true)}
          />
        )}
        <StatTile span={approvalsCount > 0 ? 3 : 4} label={t('home.stat.tasks')} value={ws.tasksCount ?? 0} icon="tasks" tone={ws.tasksCount ? 'success' : 'neutral'} />
        <StatTile span={approvalsCount > 0 ? 3 : 4} label={t('home.stat.created')} value={created} icon="calendar" tone="neutral" />

        {/* ---------- Сервисы организации ---------- */}
        <Card span={12}>
          <CardHeader title={t('home.services.title')} subtitle={t('home.services.subtitle')} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--gap-grid)' }}>
            {services.map((s) => {
              const soon = !s.href;
              const inner = (
                <>
                  <span
                    aria-hidden
                    style={{
                      width: 38, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 'var(--radius-md)', background: 'var(--surface-container)',
                      color: soon ? 'var(--muted)' : 'var(--primary-dim)', marginBottom: 'var(--spacing-3)',
                    }}
                  >
                    <Icon name={s.icon} size={20} />
                  </span>
                  <div className="title-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    {s.title}
                    {soon && <Chip size="sm" tone="neutral">{t('home.soon')}</Chip>}
                  </div>
                  <p className="label-sm" style={{ margin: '0.25rem 0 0' }}>{s.desc}</p>
                </>
              );
              return s.href ? (
                <Card key={s.key} small hoverable>
                  {/* next/link: сырой <a> перезагружал всё приложение целиком */}
                  <Link href={s.href} style={{ color: 'inherit', display: 'block' }}>{inner}</Link>
                </Card>
              ) : (
                <Card key={s.key} small style={{ opacity: 0.6 }}>{inner}</Card>
              );
            })}
          </div>
        </Card>
      </BentoGrid>

      <SubmitDocumentModal workspaceId={id} open={submitOpen} onClose={() => setSubmitOpen(false)} />
      {stackOpen && <DecisionStack open onClose={() => setStackOpen(false)} scope={{ workspaceId: id }} />}
    </>
  );
}
