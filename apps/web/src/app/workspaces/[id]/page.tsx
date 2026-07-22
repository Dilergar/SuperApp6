'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { WORKSPACE_ROLES, WORKSPACE_ROLE_RANK, type Workspace, type WorkspaceRole } from '@superapp/shared';

// Единый источник лейблов ролей — shared (Стажёр/Подрядчик уже включены).
const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  (Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map((k) => [k, WORKSPACE_ROLES[k].name]),
);

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

  if (loading || !ws) return <p className="label-md">Загрузка…</p>;

  const services: { title: string; desc: string; href?: string; color: string }[] = [
    { title: 'Сотрудники', desc: 'Ростер, должности, отделы, филиалы', href: `/workspaces/${id}/members`, color: 'var(--primary-container)' },
    { title: 'Процессы', desc: 'Конструктор бизнес-процессов на канвасе', href: `/workspaces/${id}/processes`, color: 'var(--tertiary-container)' },
    { title: 'Виртуальный офис', desc: 'Видеовстречи и собрания организации', href: `/workspaces/${id}/office`, color: 'var(--secondary-container)' },
    ...(ws.myRole === 'owner'
      ? [{ title: 'Кошелёк компании', desc: 'Валюта, казна, начисления', href: `/workspaces/${id}/wallet`, color: 'var(--secondary-container)' }]
      : []),
    ...(ws.myRole && (WORKSPACE_ROLE_RANK[ws.myRole as WorkspaceRole] ?? 0) >= WORKSPACE_ROLE_RANK.manager
      ? [{ title: 'Журнал организации', desc: 'Хроника: найм, роли, должности, задачи', href: `/workspaces/${id}/journal`, color: 'var(--primary-container)' }]
      : []),
    { title: 'Задачи организации', desc: 'Скоро', color: 'var(--secondary-container)' },
    { title: 'Календарь организации', desc: 'Скоро', color: 'var(--tertiary-container)' },
  ];

  const created = new Date(ws.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-10)', paddingLeft: 'var(--spacing-2)' }}>
        <div
          style={{
            width: '3.5rem',
            height: '3.5rem',
            flexShrink: 0,
            borderRadius: 'var(--radius-sketch)',
            background: ws.logo ? `center/cover no-repeat url(${ws.logo})` : 'var(--tertiary-container)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.6rem',
          }}
        >
          {!ws.logo && '🏢'}
        </div>
        <div>
          <h1 className="display-md" style={{ fontSize: '2rem' }}>{ws.name}</h1>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            {ws.myRole && (
              <span className="ghost-border" style={{ padding: '0.25rem 0.8rem', fontSize: '0.78rem', fontWeight: 600, color: 'var(--secondary)' }}>
                {ROLE_LABELS[ws.myRole] ?? ws.myRole}
              </span>
            )}
            <span className="label-md" style={{ fontSize: '0.85rem' }}>{ws.membersCount} сотрудников</span>
          </div>
        </div>
      </div>

      {/* Services */}
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)', paddingLeft: 'var(--spacing-2)' }}>Сервисы</h2>
      <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-6)', marginBottom: 'var(--spacing-12)' }}>
        {services.map((s, i) => {
          const inner = (
            <>
              <div style={{ width: '2.5rem', height: '2.5rem', background: s.color, borderRadius: 'var(--radius-sketch)', marginBottom: 'var(--spacing-4)', opacity: 0.7 }} />
              <div className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>{s.title}</div>
              <p className="label-md">{s.desc}</p>
            </>
          );
          return s.href ? (
            <Link key={s.title} href={s.href} className="card-elevated" style={{ display: 'block', transform: `rotate(${i === 0 ? '-0.5' : i === 2 ? '0.5' : '0'}deg)` }}>
              {inner}
            </Link>
          ) : (
            <div key={s.title} className="card-elevated" style={{ opacity: 0.55, cursor: 'not-allowed' }}>
              {inner}
            </div>
          );
        })}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3" style={{ gap: 'var(--spacing-6)' }}>
        <StatTile label="Сотрудников" value={ws.membersCount} />
        <StatTile label="Задач" value={ws.tasksCount ?? 0} />
        <StatTile label="Создана" value={created} />
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div className="display-md" style={{ color: 'var(--primary)', fontSize: '2rem' }}>{value}</div>
      <div className="label-md" style={{ marginTop: 'var(--spacing-1)' }}>{label}</div>
    </div>
  );
}
