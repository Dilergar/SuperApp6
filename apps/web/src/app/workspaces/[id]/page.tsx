'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { WORKSPACE_ROLES, WORKSPACE_ROLE_RANK, type Workspace, type WorkspaceRole } from '@superapp/shared';
import {
  BentoGrid, Card, CardHeader, Chip, EmptyState, Icon, LoadingBlock, PageHeader, StatTile,
  type IconName,
} from '@/components/ui';

// Единый источник лейблов ролей — shared (Стажёр/Подрядчик уже включены).
const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  (Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map((k) => [k, WORKSPACE_ROLES[k].name]),
);

interface ServiceCard {
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
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isReady) return;
    api
      .get(`/workspaces/${id}`)
      .then((r) => setWs(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isReady, id]);

  if (loading) return <LoadingBlock />;
  if (!ws) {
    return (
      <>
        <PageHeader breadcrumb="Организация" title="Организация" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="workspace"
              title="Организация не открылась"
              description="Возможно, у вас нет доступа или её больше нет. Обновите страницу."
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const rank = ws.myRole ? WORKSPACE_ROLE_RANK[ws.myRole as WorkspaceRole] ?? 0 : 0;

  const services: ServiceCard[] = [
    { title: 'Сотрудники', desc: 'Ростер, должности, отделы, филиалы', icon: 'staff', href: `/workspaces/${id}/members` },
    { title: 'Процессы', desc: 'Конструктор бизнес-процессов на канвасе', icon: 'processes', href: `/workspaces/${id}/processes` },
    { title: 'Виртуальный офис', desc: 'Видеовстречи и собрания организации', icon: 'office', href: `/workspaces/${id}/office` },
    ...(ws.myRole === 'owner'
      ? [{ title: 'Кошелёк компании', desc: 'Валюта, казна, начисления', icon: 'coins' as IconName, href: `/workspaces/${id}/wallet` }]
      : []),
    ...(rank >= WORKSPACE_ROLE_RANK.manager
      ? [{ title: 'Журнал организации', desc: 'Хроника: найм, роли, должности, задачи', icon: 'journal' as IconName, href: `/workspaces/${id}/journal` }]
      : []),
    { title: 'Задачи организации', desc: 'Рабочие задачи отдельным сервисом', icon: 'tasks' },
    { title: 'Календарь организации', desc: 'Общие смены, брони и события', icon: 'calendar' },
  ];

  const created = new Date(ws.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <>
      <PageHeader
        breadcrumb="Организация"
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
        chip={ws.myRole ? <Chip tone="accent" icon="user">{ROLE_LABELS[ws.myRole] ?? ws.myRole}</Chip> : undefined}
      />

      <BentoGrid>
        {/* ---------- Показатели ---------- */}
        <StatTile span={4} label="Сотрудников" value={ws.membersCount} icon="staff" tone="accent" href={`/workspaces/${id}/members`} />
        <StatTile span={4} label="Задач" value={ws.tasksCount ?? 0} icon="tasks" tone={ws.tasksCount ? 'success' : 'neutral'} />
        <StatTile span={4} label="Создана" value={created} icon="calendar" tone="neutral" />

        {/* ---------- Сервисы организации ---------- */}
        <Card span={12}>
          <CardHeader title="Сервисы" subtitle="Всё рабочее — внутри одной организации" />
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
                    {soon && <Chip size="sm" tone="neutral">скоро</Chip>}
                  </div>
                  <p className="label-sm" style={{ margin: '0.25rem 0 0' }}>{s.desc}</p>
                </>
              );
              return s.href ? (
                <Card key={s.title} small hoverable>
                  {/* next/link: сырой <a> перезагружал всё приложение целиком */}
                  <Link href={s.href} style={{ color: 'inherit', display: 'block' }}>{inner}</Link>
                </Card>
              ) : (
                <Card key={s.title} small style={{ opacity: 0.6 }}>{inner}</Card>
              );
            })}
          </div>
        </Card>
      </BentoGrid>
    </>
  );
}
