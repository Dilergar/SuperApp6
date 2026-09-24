'use client';

import { Button, Input } from '@/components/ui';
import { useState } from 'react';
import { ConsentBundleField, useConsentBundle } from '@/components/consents/ConsentBundleField';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, apiPost } from '@/lib/api';
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
import { daysUntilPurge, visibleOr, WORKSPACE_ARCHIVE_WARN_DAYS } from '@superapp/shared';
import type { Workspace, WorkspaceInvitation } from '@superapp/shared';
import { EntitlementGauge, EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { useEntitlementDenied } from '@/lib/hooks/useEntitlements';

// Момент удаления и «сколько осталось» собираются В КОМПОНЕНТЕ: и формат даты,
// и склонение дней принадлежат языку и региону зрителя (каталог + форматтеры).

// Стабильные пустые списки: `= []` в деструктуризации рождал бы новый массив на
// каждый рендер и зря будил бы всё, что зависит от этих значений.
const EMPTY: Workspace[] = [];
const EMPTY_INVITES: WorkspaceInvitation[] = [];

/**
 * Dashboard panel: the user's organizations (B2B) + incoming hiring invitations.
 * Clicking an organization card opens its page (the "switch into context" entry point).
 */
export function WorkspacesPanel() {
  const t = useTranslations('workspaces');
  const shell = useTranslations('shell');
  // Создание организации = одна галочка пакета `workspace_creation` (core/consents): владелец
  // принимает «Условия для организаций» и «Соглашение об обработке ПДн» от её имени
  const wsConsents = useConsentBundle('workspace_creation');
  const [consentError, setConsentError] = useState('');
  const tc = useTranslations('common');
  const ownedGate = useEntitlementGate('workspaces.maxOwned', null, 'ent-lock-workspaces');
  const denied = useEntitlementDenied();
  const f = useFormatters();
  const purgeMoment = (iso: string) => t('panel.purgeMoment', { date: f.date(iso), time: f.time(iso) });
  const daysWord = (n: number) => (n === 0 ? t('panel.lessThanDay') : t('panel.days', { n }));
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
      await apiPost(`/workspaces/invitations/${id}/${action}`);
      await refreshAll();
    } catch {
      setError(t('panel.inviteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (id: string) => {
    setBusyId(id);
    setError('');
    try {
      await apiPost(`/workspaces/${id}/restore`);
      await refreshAll();
    } catch (err) {
      setError(apiErrorMessage(err)); // сервер объясняет отказ сам (например, упёрлись в лимит)
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    const selection = wsConsents.selection();
    if (!selection) {
      setConsentError(shell('consents.registration.required'));
      return;
    }
    setConsentError('');
    setCreating(true);
    setError('');
    try {
      await apiPost('/workspaces', { name: name.trim(), consents: selection });
      setName('');
      wsConsents.setAccepted(false);
      setShowCreate(false);
      await refreshAll();
    } catch (err) {
      // Отказ тарифа (402) — переведённое объяснение сервера + свежий счётчик; прочее — общая фраза
      if (!denied(err)) setError(t('panel.createFailed'));
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
        <h2 className="title-md">{t('panel.title')}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <EntitlementGauge keyName="workspaces.maxOwned" />
          <EntitlementLock keyName="workspaces.maxOwned" id="ent-lock-workspaces" />
          <Button
            size="sm"
            variant={showCreate ? 'ghost' : 'primary'}
            tone={showCreate ? 'neutral' : 'success'}
            icon={showCreate ? 'close' : 'add'}
            disabled={!showCreate && ownedGate.blocked}
            aria-describedby={ownedGate.describedBy}
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? tc('actions.cancel') : t('panel.create')}
          </Button>
        </div>
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
            aria-label={t('panel.nameAria')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('panel.nameAria')}
            maxLength={100}
            wrapClassName="ws-create-field"
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <Button onClick={create} disabled={!name.trim() || wsConsents.unavailable} loading={creating} variant="primary" tone="success" icon="add">{t('panel.create')}</Button>
          <div style={{ flexBasis: '100%' }}>
            <ConsentBundleField state={wsConsents} variant="workspace" error={consentError || null} />
          </div>
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
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-1)' }}>{t('panel.invitation')}</div>
                <div className="title-md">{inv.workspaceName}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-1)', flexWrap: 'wrap' }}>
                  <PersonChip size="S" userId={inv.invitedBy} firstName={inv.invitedByName} />
                  <span className="label-md" style={{ fontSize: '0.85rem' }}>
                    {t('panel.hiredAsTrainee')}
                    {inv.positionName ? ` · ${inv.positionName}` : ''}
                    {inv.branchNames.length ? ` · ${inv.branchNames.join(', ')}` : ''}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                <Button size="sm" variant="primary" tone="success" icon="check" disabled={busyId === inv.id} onClick={() => respond(inv.id, 'accept')}>{t('panel.accept')}</Button>
                <Button size="sm" variant="matte" tone="danger" icon="close" disabled={busyId === inv.id} onClick={() => respond(inv.id, 'reject')}>{t('panel.reject')}</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* My organizations */}
      {loading ? (
        <p className="label-md" style={{ paddingLeft: 'var(--spacing-2)' }}>{tc('state.loading')}</p>
      ) : workspaces.length === 0 ? (
        <p className="label-md" style={{ paddingLeft: 'var(--spacing-2)', opacity: 0.7 }}>
          {invites.length > 0 ? t('panel.acceptToJoin') : t('panel.none')}
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
            {t('panel.archive', { n: archived.length })}
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
                      {t('panel.archivedLine', { n: visibleOr(ws.membersCount, 0) })}
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
                            {urgent ? '⚠️ ' : ''}
                            {t('panel.purgeLine', { moment: purgeMoment(ws.purgeAt), left: daysWord(left) })}
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
                    {t('panel.restore')}
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
