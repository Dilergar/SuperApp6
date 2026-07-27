'use client';

import { Button, Input } from '@/components/ui';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import { CompanyCard } from '../workspaces/[id]/CompanyCard';
import { PersonChip } from '../circles/PersonCard';
import {
  fetchWorkspaces,
  fetchWorkspacesArchived,
  fetchWorkspaceIncomingInvitations,
  workspacesKey,
  workspacesArchivedKey,
  workspacesIncomingInvitationsKey,
} from '@/lib/queries';
import { daysUntilPurge, pluralDays, WORKSPACE_ARCHIVE_WARN_DAYS } from '@superapp/shared';
import type { Workspace, WorkspaceInvitation } from '@superapp/shared';

/** «26.10.2026 в 19:14» — дата и время удаления в поясе зрителя. */
function formatPurgeMoment(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${date} в ${time}`;
}

const daysWord = (n: number) => (n === 0 ? 'меньше суток' : pluralDays(n));

// Стабильные пустые списки: `= []` в деструктуризации рождал бы новый массив на
// каждый рендер и зря будил бы всё, что зависит от этих значений.
const EMPTY: Workspace[] = [];
const EMPTY_INVITES: WorkspaceInvitation[] = [];

/**
 * Dashboard panel: the user's organizations (B2B) + incoming hiring invitations.
 * Clicking an organization card opens its page (the "switch into context" entry point).
 */
export function WorkspacesPanel() {
  const [showArchive, setShowArchive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  // Счётчик «Пространств» на этой же странице живёт в профиле — перечитываем его вместе
  // со списком, иначе после создания/архивации/возврата число расходится со списком до
  // перезагрузки (ровно та картинка, из-за которой архив и понадобился).
  const fetchProfile = useAuthStore((s) => s.fetchProfile);
  const queryClient = useQueryClient();

  // Ключи общие с переключателем контекста в топбаре (AppShell) — список организаций
  // на дашборде и в шелле это ОДИН кэш, поэтому лишнего запроса больше нет, а любая
  // мутация ниже обновляет оба места разом.
  const { data: workspaces = EMPTY, isPending: loading } = useQuery({
    queryKey: workspacesKey,
    queryFn: fetchWorkspaces,
    staleTime: 60_000,
  });
  const { data: invites = EMPTY_INVITES } = useQuery({
    queryKey: workspacesIncomingInvitationsKey,
    queryFn: fetchWorkspaceIncomingInvitations,
    staleTime: 60_000,
  });
  const { data: archived = EMPTY } = useQuery({
    queryKey: workspacesArchivedKey,
    queryFn: fetchWorkspacesArchived,
    staleTime: 60_000,
  });

  /** Обновить оба места сразу: префикс накрывает список, архив и приглашения. */
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: workspacesKey });
    await fetchProfile().catch(() => undefined); // счётчик — не повод рушить список
  };

  const respond = async (id: string, action: 'accept' | 'reject') => {
    setBusyId(id);
    setError('');
    try {
      await api.post(`/workspaces/invitations/${id}/${action}`);
      await refreshAll();
    } catch {
      setError('Не удалось обработать приглашение');
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (id: string) => {
    setBusyId(id);
    setError('');
    try {
      await api.post(`/workspaces/${id}/restore`);
      await refreshAll();
    } catch (err) {
      setError(apiErrorMessage(err)); // сервер объясняет отказ сам (например, упёрлись в лимит)
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    try {
      await api.post('/workspaces', { name: name.trim() });
      setName('');
      setShowCreate(false);
      await refreshAll();
    } catch {
      setError('Не удалось создать организацию');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--spacing-6)',
          paddingLeft: 'var(--spacing-2)',
        }}
      >
        <h2 className="title-md">Организации</h2>
        <Button
          size="sm"
          variant={showCreate ? 'ghost' : 'primary'}
          tone={showCreate ? 'neutral' : 'success'}
          icon={showCreate ? 'close' : 'add'}
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? 'Отмена' : 'Создать'}
        </Button>
      </div>

      {error && (
        <p className="label-md" style={{ color: 'var(--danger)', marginBottom: 'var(--spacing-4)' }}>
          {error}
        </p>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="card" style={{ marginBottom: 'var(--spacing-6)', display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <Input
            aria-label="Название организации"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название организации"
            maxLength={100}
            wrapClassName="ws-create-field"
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <Button onClick={create} disabled={!name.trim()} loading={creating} variant="primary" tone="success" icon="add">Создать</Button>
        </div>
      )}

      {/* Incoming invitations */}
      {invites.length > 0 && (
        <div className="ui-stack" style={{ marginBottom: 'var(--spacing-6)', gap: 'var(--spacing-4)' }}>
          {invites.map((inv) => (
            <div
              key={inv.id}
              className="alert-accent-inline"
              style={{
                padding: 'var(--spacing-5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--spacing-4)',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-1)' }}>Приглашение</div>
                <div className="title-md">{inv.workspaceName}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-1)', flexWrap: 'wrap' }}>
                  <PersonChip size="S" userId={inv.invitedBy} firstName={inv.invitedByName} />
                  <span className="label-md" style={{ fontSize: '0.85rem' }}>
                    Нанимаетесь Стажёром
                    {inv.positionName ? ` · ${inv.positionName}` : ''}
                    {inv.branchNames.length ? ` · ${inv.branchNames.join(', ')}` : ''}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                <Button size="sm" variant="primary" tone="success" icon="check" disabled={busyId === inv.id} onClick={() => respond(inv.id, 'accept')}>Принять</Button>
                <Button size="sm" variant="matte" tone="danger" icon="close" disabled={busyId === inv.id} onClick={() => respond(inv.id, 'reject')}>Отклонить</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* My organizations */}
      {loading ? (
        <p className="label-md" style={{ paddingLeft: 'var(--spacing-2)' }}>Загрузка…</p>
      ) : workspaces.length === 0 ? (
        <p className="label-md" style={{ paddingLeft: 'var(--spacing-2)', opacity: 0.7 }}>
          {invites.length > 0 ? 'Примите приглашение, чтобы вступить в организацию.' : 'У вас пока нет организаций.'}
        </p>
      ) : (
        <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-6)' }}>
          {workspaces.map((ws) => (
            <Link
              key={ws.id}
              href={`/workspaces/${ws.id}`}
              className="card-elevated"
              style={{ display: 'block' }}
            >
              <CompanyCard ws={ws} compact />
            </Link>
          ))}
        </div>
      )}

      {/* Архив: деактивированные организации владельца. Деактивация ничего не удаляет —
          данные, роли и справочники на месте, поэтому возврат в один клик. */}
      {!loading && archived.length > 0 && (
        <div style={{ marginTop: 'var(--spacing-6)', paddingLeft: 'var(--spacing-2)' }}>
          <Button
            variant="ghost"
            size="sm"
            icon={showArchive ? 'caretDown' : 'caretRight'}
            aria-expanded={showArchive}
            onClick={() => setShowArchive((v) => !v)}
          >
            Архив · {archived.length}
          </Button>

          {showArchive && (
            <div className="ui-stack" style={{ marginTop: 'var(--spacing-3)', gap: 'var(--spacing-3)' }}>
              {archived.map((ws) => (
                <div
                  key={ws.id}
                  className="alert-accent-inline"
                  style={{
                    padding: 'var(--spacing-4) var(--spacing-5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--spacing-4)',
                    flexWrap: 'wrap',
                    opacity: 0.85,
                  }}
                >
                  <div>
                    <div className="title-md">{ws.name}</div>
                    <div className="label-md" style={{ fontSize: '0.85rem', opacity: 0.8 }}>
                      В архиве · участников {ws.membersCount}
                    </div>
                    {ws.purgeAt &&
                      (() => {
                        // Те же рубежи, что и у писем-предупреждений: на последней неделе
                        // строка становится заметной — центра уведомлений в вебе ещё нет,
                        // и архив остаётся единственным местом, где это видно.
                        const left = daysUntilPurge(ws.purgeAt);
                        const urgent = left <= Math.max(...WORKSPACE_ARCHIVE_WARN_DAYS);
                        return (
                          <div
                            className="label-md"
                            style={{
                              fontSize: '0.85rem',
                              marginTop: 'var(--spacing-1)',
                              color: 'var(--primary)',
                              fontWeight: urgent ? 700 : undefined,
                            }}
                          >
                            {urgent ? '⚠️ ' : ''}Будет удалена навсегда {formatPurgeMoment(ws.purgeAt)} · осталось{' '}
                            {daysWord(left)}
                          </div>
                        );
                      })()}
                  </div>
                  <Button
                    size="sm"
                    variant="matte"
                    icon="undo"
                    loading={busyId === ws.id}
                    onClick={() => restore(ws.id)}
                  >
                    Восстановить
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
