'use client';

// ============================================================
// «Настроить доступ» к объекту Диска.
//
// Людей и Группы выбирает EntitySelector (он же отдаёт принципалы в том виде, в
// котором их понимает core/access); на диске организации к ним добавляются оси
// оргструктуры — отдел, должность, филиал. Унаследованные от папок-предков гранты
// показываются отдельно и не снимаются здесь: их место — та папка, где они выданы.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DRIVE_NODE_REF_TYPE, type DriveNodeDto, type DriveRole, type DriveShareDto } from '@superapp/shared';
import { Button, Chip, Icon, LoadingBlock, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { ShareLinkSection } from '@/components/ShareLinkSection';
import type { Principal } from '@/lib/entities';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { driveNodeKey, driveSharesKey } from '@/lib/queries';
import { fetchDriveNode, fetchDriveShares, shareDriveNode, unshareDriveNode } from '@/lib/drive-api';
import { PersonChip } from '../../circles/PersonCard';

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Смотрит' },
  { value: 'editor', label: 'Правит' },
  { value: 'manager', label: 'Управляет доступом' },
];

const ROLE_LABEL: Record<DriveRole, string> = {
  viewer: 'смотрит',
  editor: 'правит',
  manager: 'управляет доступом',
};

export function DriveShareModal({
  node,
  isWorkspace,
  workspaceId,
  onClose,
}: {
  node: DriveNodeDto;
  isWorkspace: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Principal[]>([]);
  const [role, setRole] = useState<DriveRole>('viewer');

  const { data: shares, isPending } = useQuery({
    queryKey: driveSharesKey(node.id),
    queryFn: () => fetchDriveShares(node.id),
  });

  // Роль зрителя ИМЕННО на этом узле. Кто именно им распоряжается, из строки списка не
  // видно, а меню открывается по праву «правит»: на диске организации это каждый
  // сотрудник. Без гейта им показывали формы, которые сервер отвергает.
  const { data: detail } = useQuery({
    queryKey: driveNodeKey(node.id),
    queryFn: () => fetchDriveNode(node.id),
  });
  const canManage = detail ? detail.access === 'manager' || detail.access === 'owner' : false;

  // На диске организации личной Группы в пикере НЕТ: сервер её отвергает
  // (`assertPrincipalAllowed` — «пустить родственников в рабочие файлы» нельзя),
  // а предлагать то, что сервер отвергнет, = «кнопка не работает» для человека.
  const types = useMemo(
    () => (isWorkspace ? ['user', 'department', 'position', 'branch'] : ['user', 'circle']),
    [isWorkspace],
  );

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: driveSharesKey(node.id) });
    void qc.invalidateQueries({ queryKey: ['drive'] });
  }, [qc, node.id]);

  const grant = useMutation({
    mutationFn: async () => {
      for (const p of picked) {
        await shareDriveNode(node.id, { principalType: p.type, principalId: p.id, role });
      }
    },
    onSuccess: () => {
      setPicked([]);
      refresh();
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });

  const revoke = useMutation({
    mutationFn: (s: DriveShareDto) => unshareDriveNode(node.id, s.principalType, s.principalId),
    onSuccess: refresh,
    onError: (err) => toastError(apiErrorMessage(err)),
  });

  const own = (shares ?? []).filter((s) => !s.inherited);
  const inherited = (shares ?? []).filter((s) => s.inherited);

  return (
    <Modal open onClose={onClose} title={`Доступ к «${node.name}»`} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {canManage ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <EntitySelector
                value={picked}
                onChange={setPicked}
                types={types}
                context={workspaceId ? { workspaceId } : undefined}
                placeholder="Кому открыть доступ"
              />
            </div>
            <Select
              label="Роль"
              value={role}
              options={ROLE_OPTIONS}
              onChange={(v) => setRole(v as DriveRole)}
              className="w-44"
            />
            <Button
              tone="success"
              disabled={!picked.length || grant.isPending}
              loading={grant.isPending}
              onClick={() => grant.mutate()}
            >
              Открыть
            </Button>
          </div>
        ) : (
          <p className="body-sm" style={{ margin: 0, color: 'var(--muted)' }}>
            Здесь видно, кому открыт доступ. Менять его и раздавать ссылки наружу может тот,
            кто управляет этим объектом.
          </p>
        )}

        {isPending ? (
          <LoadingBlock />
        ) : (
          <>
            <section>
              <p className="label-caps" style={{ marginBottom: 8 }}>Доступ выдан здесь</p>
              {own.length === 0 ? (
                <p className="body-sm" style={{ color: 'var(--muted)' }}>Пока никому.</p>
              ) : (
                <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {own.map((s) => (
                    <li
                      key={`${s.principalType}:${s.principalId}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <SharePrincipal share={s} />
                      <Chip tone="accent">{ROLE_LABEL[s.role]}</Chip>
                      <span style={{ flex: 1 }} />
                      {canManage && (
                        <Button
                          variant="matte"
                          tone="danger"
                          size="sm"
                          onClick={() => revoke.mutate(s)}
                          disabled={revoke.isPending}
                        >
                          Закрыть
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {inherited.length > 0 && (
              <section>
                <p className="label-caps" style={{ marginBottom: 8 }}>Унаследовано от папок</p>
                <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {inherited.map((s) => (
                    <li
                      key={`${s.nodeId}:${s.principalType}:${s.principalId}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <SharePrincipal share={s} />
                      <Chip tone="neutral">{ROLE_LABEL[s.role]}</Chip>
                      <span className="label-sm" style={{ color: 'var(--muted)' }}>
                        <Icon name="folder" size={12} /> {s.nodeName}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="body-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
                  Такой доступ снимается там, где он выдан, — в самой папке.
                </p>
              </section>
            )}

            {/* Наружу — движок гостевых ссылок; блок один и тот же во всех сервисах.
                Показываем только управляющему: планка движка — «управляет доступом»,
                и остальным этот блок отвечал бы отказом на каждое действие. */}
            {canManage && (
              <section style={{ borderTop: '1px solid var(--divider)', paddingTop: 'var(--spacing-5)' }}>
                <p className="label-caps" style={{ marginBottom: 8 }}>Доступ по ссылке наружу</p>
                <ShareLinkSection refType={DRIVE_NODE_REF_TYPE} refId={node.id} />
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Человек — всегда карточкой (несущее правило платформы), остальное — чипом */
function SharePrincipal({ share }: { share: DriveShareDto }) {
  if (share.principalType === 'user') {
    return <PersonChip size="S" userId={share.principalId} firstName={share.principalName ?? 'Человек'} />;
  }
  return <Chip tone="neutral">{share.principalName ?? share.principalType}</Chip>;
}
