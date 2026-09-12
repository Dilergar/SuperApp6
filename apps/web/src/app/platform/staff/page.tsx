'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { PlatformCommandDto, PlatformStaffDto, PlatformUserHitDto } from '@superapp/shared';
import { Alert, Button, Chip, LoadingBlock, Menu, Modal, PageHeader, Table, TableCell, TableRow } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { fetchPlatformCommands, fetchPlatformStaff, platformCommandsKey, platformStaffKey } from '@/lib/platform/api';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { useFormatters } from '@/lib/format';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { PlatformUserPicker } from '@/components/platform/PlatformUserPicker';

/** Сотрудники платформы: таблица, добавить (выбор человека поиском кабинета), выдать/снять роль, приостановить — всё командами (critical: причина + step-up). */
export default function PlatformStaffPage() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const f = useFormatters();
  const { can, me } = usePlatformAuth();
  const staffQ = useQuery({ queryKey: platformStaffKey, queryFn: fetchPlatformStaff });
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PlatformUserHitDto | null>(null);
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const cmd = (key: string) => commandsQ.data?.find((c) => c.key === key) ?? null;

  const open = (key: string, input: Record<string, unknown>) => {
    const c = cmd(key);
    if (c) setRunner({ command: c, input });
  };

  const rowActions = (s: PlatformStaffDto) => {
    const self = s.userId === me?.userId;
    const items = [];
    if (cmd('platform.staff.role.grant')) items.push({ key: 'grant', label: t('commands.platformStaffRoleGrant.title'), icon: 'crown' as const, disabled: self, onClick: () => open('platform.staff.role.grant', { userId: s.userId, role: 'platform_owner' }) });
    if (cmd('platform.staff.role.revoke')) items.push({ key: 'revoke', label: t('commands.platformStaffRoleRevoke.title'), icon: 'undo' as const, disabled: self || s.roles.length === 0, onClick: () => open('platform.staff.role.revoke', { userId: s.userId, role: s.roles[0]?.role ?? 'platform_owner' }) });
    if (cmd('platform.staff.suspend')) items.push({ key: 'suspend', label: t('commands.platformStaffSuspend.title'), icon: 'blocked' as const, danger: true, disabled: self || s.status !== 'active', onClick: () => open('platform.staff.suspend', { userId: s.userId }) });
    return items;
  };

  return (
    <>
      <PageHeader
        breadcrumb={t('shell.title')}
        title={t('nav.staff')}
        description={t('staff.description')}
        actions={can('platform.staff.write') && cmd('platform.staff.add') ? <Button variant="primary" icon="add" onClick={() => setPicking(true)}>{t('staff.add')}</Button> : undefined}
      />
      {staffQ.isPending ? (
        <LoadingBlock />
      ) : staffQ.isError ? (
        <Alert tone="danger">{tc('state.error')}</Alert>
      ) : (
        <Table
          columns={[
            { key: 'person', label: t('staff.col.person') },
            { key: 'roles', label: t('staff.col.roles') },
            { key: 'status', label: t('staff.col.status'), width: 'max-content' },
            { key: 'since', label: t('staff.col.since'), width: 'max-content', hideOnMobile: true },
            { key: 'actions', label: '', width: 'max-content' },
          ]}
          lines
          aria-label={t('nav.staff')}
        >
          {(staffQ.data ?? []).map((s, i) => {
            const name = `${s.person.firstName} ${s.person.lastName ?? ''}`.trim();
            return (
              <TableRow key={s.userId} rowIndex={i + 1}>
                <TableCell>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    <PersonAvatar userId={s.userId} name={name} avatar={s.person.avatar} size="sm" />
                    <span className="body-sm">{name}</span>
                    {s.note && <span className="label-sm">{s.note}</span>}
                  </span>
                </TableCell>
                <TableCell>
                  <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                    {s.roles.length === 0 && <span className="label-sm">{t('staff.noRoles')}</span>}
                    {s.roles.map((r) => (
                      <Chip key={r.role} tone="accent" size="sm" title={r.expiresAt ? t('staff.until', { date: f.date(r.expiresAt) }) : undefined}>{t(`roles.${r.role}`)}</Chip>
                    ))}
                  </span>
                </TableCell>
                <TableCell><Chip tone={s.status === 'active' ? 'success' : 'warning'} size="sm">{t(`staffStatus.${s.status}`)}</Chip></TableCell>
                <TableCell hideOnMobile><span className="label-sm">{f.date(s.createdAt)}</span></TableCell>
                <TableCell align="end">{rowActions(s).length > 0 && <Menu items={rowActions(s)} label={t('card.actions')} />}</TableCell>
              </TableRow>
            );
          })}
        </Table>
      )}

      <Modal
        open={picking}
        onClose={() => { setPicking(false); setPicked(null); }}
        title={t('staff.add')}
        size="sm"
        footer={
          <Button variant="primary" disabled={!picked} onClick={() => { if (picked) { setPicking(false); open('platform.staff.add', { userId: picked.id, role: 'platform_owner' }); setPicked(null); } }}>
            {tc('actions.continue')}
          </Button>
        }
      >
        <PlatformUserPicker value={picked} onChange={setPicked} />
      </Modal>

      {runner && <CommandRunner command={runner.command} initialInput={runner.input} open onClose={() => setRunner(null)} />}
    </>
  );
}
