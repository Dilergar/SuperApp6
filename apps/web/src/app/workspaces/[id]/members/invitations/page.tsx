'use client';

// ============================================================
// «Приглашения»: форма 1в1 как «Добавить в окружение» (b2c) — номер → поиск
// человека (имя с инициалом) → блоки-чипы Должность/Объекты → отправить.
// Наём всегда в Стажёра (роль не выбирается). Объектов можно несколько; без
// объектов назначение попадёт в ОСНОВНОЙ объект организации.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { workspaceInvitationsKey } from '@/lib/queries';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmptyState, IconButton, Input, LoadingBlock,
} from '@/components/ui';
import { PersonAvatar } from '../../../../messenger/messenger-ui';
import type { StaffDirectory, UserLookupDto, WorkspaceInvitation } from '@superapp/shared';
import { ChipPickerBlock, MembersHeader, membersSectionHref, useLegacyMembersTabRedirect, useMembersBase } from '../members-lib';

export default function MembersInvitationsPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  useLegacyMembersTabRedirect(workspaceId);
  const { isReady, ws, wsQ, canStaff, dir } = useMembersBase(workspaceId);
  const [error, setError] = useState('');

  const invitesQ = useQuery({
    queryKey: workspaceInvitationsKey(workspaceId),
    queryFn: async () => await apiGet<WorkspaceInvitation[]>(`/workspaces/${workspaceId}/invitations`),
    enabled: isReady && canStaff,
  });

  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;
  if (!canStaff) {
    return (
      <EmptyState
        icon="lock"
        title="Нанимают управляющие"
        description="Приглашать в организацию может Менеджер и выше."
        action={<Button variant="matte" icon="arrowLeft" href={membersSectionHref(workspaceId, 'people')}>К людям</Button>}
      />
    );
  }

  return (
    <MembersHeader
      ws={ws}
      title="Приглашения"
      description="Наём по номеру: каждый приходит Стажёром"
      error={error}
      onCloseError={() => setError('')}
    >
      <InvitesSection workspaceId={workspaceId} dir={dir} invites={invitesQ.data ?? []} onError={setError} />
    </MembersHeader>
  );
}

function InvitesSection({
  workspaceId, dir, invites, onError,
}: {
  workspaceId: string;
  dir: StaffDirectory;
  invites: WorkspaceInvitation[];
  onError: (m: string) => void;
}) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('+7');
  const [posId, setPosId] = useState('');
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [cancelling, setCancelling] = useState<WorkspaceInvitation | null>(null);

  // Поиск по номеру — тот же механизм, что в «Моё окружение» (debounce + /users/lookup).
  const [lookup, setLookup] = useState<UserLookupDto | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePhoneLookup = (value: string) => {
    setPhone(value);
    setLookup(null);
    setLookupDone(false);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (value.length >= 12) {
      setLookupLoading(true);
      lookupTimer.current = setTimeout(async () => {
        try {
          setLookup(await apiGet<UserLookupDto | null>('/users/lookup', { params: { phone: value } }));
          setLookupDone(true);
        } catch {
          setLookupDone(true);
        } finally {
          setLookupLoading(false);
        }
      }, 500);
    }
  };

  useEffect(() => {
    return () => { if (lookupTimer.current) clearTimeout(lookupTimer.current); };
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: workspaceInvitationsKey(workspaceId) });

  const invite = useMutation({
    mutationFn: async () => {
      if (!/^\+7\d{10}$/.test(phone)) throw new Error('bad-phone');
      return apiPost(`/workspaces/${workspaceId}/invitations`, {
        phone,
        positionId: posId || undefined,
        branchIds: branchIds.length ? branchIds : undefined,
        message: message.trim() || undefined,
      });
    },
    onSuccess: () => {
      setPhone('+7'); setLookup(null); setLookupDone(false);
      setPosId(''); setBranchIds([]); setMessage('');
      onError('');
      refresh();
    },
    onError: (e) =>
      onError((e as Error)?.message === 'bad-phone' ? 'Номер в формате +7XXXXXXXXXX' : apiErrorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: async (invId: string) => apiPost(`/workspaces/${workspaceId}/invitations/${invId}/cancel`),
    onSuccess: () => { setCancelling(null); onError(''); refresh(); },
    onError: (e) => { setCancelling(null); onError(apiErrorMessage(e)); },
  });

  const defaultBranch = dir.branches.find((b) => b.isDefault);

  return (
    <>
      <BentoGrid>
        <Card span={7}>
          <CardHeader
            title="Пригласить сотрудника"
            subtitle="Каждый наём — в роли «Стажёр». Роль повышается вручную (позже — после обучения в Додзё)"
          />
          <form onSubmit={(e) => { e.preventDefault(); invite.mutate(); }} className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <Input
              label="Номер телефона"
              type="tel"
              value={phone}
              onChange={(e) => handlePhoneLookup(e.target.value)}
              placeholder="+77001234567"
              icon="call"
              autoFocus
            />

            {lookupLoading && <p className="label-sm" style={{ margin: 0 }}>Поиск…</p>}
            {lookupDone && lookup && (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)',
                  border: '1px solid var(--primary-border)', background: 'var(--primary-container)',
                  borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem',
                }}
              >
                <PersonAvatar userId={lookup.id} name={lookup.firstName} avatar={lookup.avatar} size="sm" />
                <span>
                  <span className="title-sm">{lookup.firstName} {lookup.lastName || ''}</span>
                  <span className="label-sm" style={{ display: 'block' }}>{lookup.phone}</span>
                </span>
              </div>
            )}
            {lookupDone && !lookup && (
              <Alert tone="neutral" icon="info">Пользователь не найден — приглашение уйдёт на этот номер</Alert>
            )}

            {/* Должность (одна) + Объекты (несколько) — чипами, как роли в «Окружении» */}
            <ChipPickerBlock
              label="Должность (необязательно)"
              icon="position"
              options={dir.positions.map((p) => ({ id: p.id, label: p.departmentName ? `${p.name} · ${p.departmentName}` : p.name }))}
              selected={posId ? [posId] : []}
              onToggle={(id) => setPosId((cur) => (cur === id ? '' : id))}
              emptyHint="Создайте должности в «Орг. структуре»"
            />
            <ChipPickerBlock
              label={`Объекты (можно несколько; без выбора — основной${defaultBranch ? ` «${defaultBranch.name}»` : ''})`}
              icon="branch"
              options={dir.branches.map((b) => ({ id: b.id, label: b.name }))}
              selected={branchIds}
              onToggle={(id) => setBranchIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
              emptyHint="Создайте объекты в разделе «Объекты»"
            />

            <Input
              label="Сообщение"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              placeholder="Привет! Приглашаем в команду…"
            />

            <div>
              <Button type="submit" variant="primary" tone="success" icon="send" disabled={phone.length < 12} loading={invite.isPending}>
                Отправить приглашение
              </Button>
            </div>
          </form>
        </Card>

        <Card span={5}>
          <CardHeader title="Ожидают ответа" subtitle={invites.length ? `${invites.length} приглашений` : undefined} />
          {invites.length === 0 ? (
            <EmptyState icon="userAdd" title="Нет ожидающих приглашений" description="Отправленные наймы появятся здесь." />
          ) : (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)',
                    flexWrap: 'wrap', padding: '0.5rem 0.75rem', border: '1px solid var(--divider)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span className="title-sm">{inv.toPhone}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
                      <Chip size="sm" tone="neutral" icon="graduation">Стажёр</Chip>
                      {inv.positionName && <Chip size="sm" icon="position">{inv.positionName}</Chip>}
                      {inv.branchNames.map((b) => <Chip key={b} size="sm" icon="branch">{b}</Chip>)}
                    </span>
                  </span>
                  <IconButton icon="close" label="Отменить приглашение" size={30} onClick={() => setCancelling(inv)} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      <ConfirmDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        onConfirm={() => { if (cancelling) cancel.mutate(cancelling.id); }}
        title="Отменить приглашение?"
        message={cancelling ? `Приглашение на ${cancelling.toPhone} перестанет действовать.` : ''}
        confirmLabel="Отменить приглашение"
        cancelLabel="Оставить"
        danger
        loading={cancel.isPending}
      />
    </>
  );
}
