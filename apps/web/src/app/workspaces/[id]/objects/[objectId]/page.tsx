'use client';

// ============================================================
// Обзор объекта: адрес, юрлицо, пояс, управляющий, счётчики, коллеги, фото.
// Смысл несёт форма: состояние — Chip, действие — Button.
// ============================================================

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OBJECT_KINDS, type FileDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  LoadingBlock,
  StatTile,
  useConfirm,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { AttachmentsSection } from '@/components/files/AttachmentsSection';
import { NotesPanel } from '@/components/notes/NotesPanel';
import { apiDelete, apiErrorMessage, apiGet, apiPost } from '@/lib/api';

import { FALLBACK_TZ, todayIn } from '@/lib/objects-time';
import {
  objectFilesKey,
  objectKey,
  objectPeopleKey,
  objectShiftsKey,
  objectsMineKey,
  objectsTreeKey,
} from '@/lib/queries';
import { fetchObject, fetchObjectTree, fetchShiftBoard, objectsApi } from '../objects-api';
import { ObjectForm } from '../_components/ObjectForm';

import { toastApiError } from '@/lib/api-errors';
interface RosterRow {
  userId: string;
  userName: string;
  positionName: string | null;
}

export default function ObjectOverviewPage() {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const { isReady } = useRequireAuth();
  const { id, objectId } = useParams<{ id: string; objectId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [editing, setEditing] = useState(false);

  const { data: node, isPending, error } = useQuery({
    queryKey: objectKey(id, objectId),
    queryFn: () => fetchObject(id, objectId),
    enabled: isReady && !!id && !!objectId,
  });

  // «Основной объект» назначает владелец/админ — тот же признак, что открывает
  // создание объектов верхнего уровня (`canCreate` дерева). Своих caps на это у
  // узла нет: управляющий правит объект, но основным его не делает.
  const { data: tree } = useQuery({
    queryKey: objectsTreeKey(id, false),
    queryFn: () => fetchObjectTree(id, false),
    enabled: isReady && !!id,
  });

  const { data: files } = useQuery({
    queryKey: objectFilesKey(id, objectId),
    queryFn: () => apiGet<FileDto[]>(`/workspaces/${id}/objects/${objectId}/files`),
    enabled: isReady && !!objectId,
  });

  // «Смен сегодня» — счётчик обзора: сетка за один день В ПОЯСЕ ОБЪЕКТА.
  // UTC-«сегодня» с полуночи до 05:00 местного времени указывало на вчера —
  // ровно в те часы, когда точки и склады работают.
  const today = todayIn(node?.timeZone ?? FALLBACK_TZ);
  const { data: todayBoard } = useQuery({
    queryKey: objectShiftsKey(id, objectId, today, today),
    queryFn: () => fetchShiftBoard(id, objectId, today, today),
    // Ждём объект: иначе первый запрос уходит по запасному поясу и ключ меняется.
    enabled: isReady && !!objectId && !!node,
  });

  const { data: roster } = useQuery({
    queryKey: objectPeopleKey(id, objectId),
    queryFn: () => apiGet<RosterRow[]>(`/workspaces/${id}/objects/${objectId}/people`),
    enabled: isReady && !!objectId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: objectKey(id, objectId) });
    void qc.invalidateQueries({ queryKey: objectsTreeKey(id, false) });
    void qc.invalidateQueries({ queryKey: objectsTreeKey(id, true) });
    void qc.invalidateQueries({ queryKey: objectsMineKey(id) });
  };

  const removeObject = useMutation({
    mutationFn: () => objectsApi.remove(id, objectId),
    onSuccess: () => {
      invalidate();
      router.push(`/workspaces/${id}/objects`);
    },
    onError: (e) => toastApiError(e),
  });

  const archive = useMutation({
    mutationFn: () =>
      node?.archivedAt ? objectsApi.restore(id, objectId) : objectsApi.archive(id, objectId),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });

  const makeDefault = useMutation({
    mutationFn: () => objectsApi.makeDefault(id, objectId),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });

  const attach = useMutation({
    mutationFn: (fileId: string) => apiPost(`/workspaces/${id}/objects/${objectId}/files`, { fileId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: objectFilesKey(id, objectId) }),
    onError: (e) => toastApiError(e),
  });
  const detach = useMutation({
    mutationFn: (fileId: string) => apiDelete(`/workspaces/${id}/objects/${objectId}/files/${fileId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: objectFilesKey(id, objectId) }),
    onError: (e) => toastApiError(e),
  });

  const todayShifts = todayBoard?.shifts.filter((sh) => sh.status !== 'cancelled').length ?? 0;

  if (!isReady) return null;
  if (isPending) return <LoadingBlock />;
  if (!node) {
    return (
      <Card>
        <EmptyState
          icon="blocked"
          title={t('card.notOpened')}
          description={error ? apiErrorMessage(error) : t('card.notOpenedHint')}
          action={
            <Button variant="primary" icon="arrowLeft" href={`/workspaces/${id}/objects`}>
              {t('card.backToList')}
            </Button>
          }
        />
      </Card>
    );
  }

  const kindLabel = OBJECT_KINDS.some((k) => k.value === node.kind) ? t(`kind.${node.kind}`) : t('entity');
  // Основным делает только владелец/админ, и только живой объект — иначе сервер
  // ответит 409 «Архивный объект основным не делают».
  const canMakeDefault = !!tree?.canCreate && !node.isDefault && !node.archivedAt;

  return (
    <>
      <BentoGrid>
        <Card span={7}>
          <CardHeader
            title={t('card.about')}
            actions={
              node.caps.manage ? (
                <>
                  <Button size="sm" variant="matte" icon="edit" onClick={() => setEditing(true)}>
                    {tc('actions.edit')}
                  </Button>
                  {canMakeDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="star"
                      loading={makeDefault.isPending}
                      onClick={() =>
                        confirm(
                          {
                            title: t('card.makeDefaultTitle'),
                            message: t('card.makeDefaultMessage', { name: node.name }),
                            confirmLabel: t('card.makeDefault'),
                          },
                          () => makeDefault.mutateAsync().then(() => undefined),
                        )
                      }
                    >
                      {t('card.makeDefault')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={archive.isPending}
                    onClick={() =>
                      node.archivedAt
                        ? archive.mutate()
                        : confirm(
                            {
                              title: t('card.archiveTitle'),
                              message: t('card.archiveMessage', { name: node.name }),
                              confirmLabel: t('card.archive'),
                            },
                            () => archive.mutateAsync().then(() => undefined),
                          )
                    }
                  >
                    {node.archivedAt ? t('card.restore') : t('card.archive')}
                  </Button>
                  {!node.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      tone="danger"
                      loading={removeObject.isPending}
                      onClick={() =>
                        confirm(
                          {
                            title: t('card.deleteTitle'),
                            message: t('card.deleteMessage'),
                            confirmLabel: tc('actions.delete'),
                            danger: true,
                          },
                          () => removeObject.mutateAsync().then(() => undefined),
                        )
                      }
                    >
                      {tc('actions.delete')}
                    </Button>
                  )}
                </>
              ) : undefined
            }
          />
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            <Row label={tc('labels.type')} value={kindLabel} />
            <Row label={t('form.address')} value={node.address ?? tc('labels.dash')} />
            <Row
              label={t('form.legalEntity')}
              value={
                node.effectiveLegalEntityName
                  ? `${node.effectiveLegalEntityName}${
                      node.legalEntityInherited
                        ? node.parentId
                          ? ` (${t('card.legalFromParent')})`
                          : ` (${t('card.legalHead')})`
                        : ''
                    }`
                  : tc('labels.dash')
              }
            />
            <Row label={t('form.timeZone')} value={node.timeZone} />
            <Row label={t('form.headPosition')} value={node.headPositionName ?? tc('labels.dash')} />
            {node.note && <Row label={t('form.note')} value={node.note} />}
          </div>
        </Card>

        <div style={{ gridColumn: 'span 5' }}>
          <BentoGrid>
            <StatTile span={6} label={t('card.people')} value={node.membersCount} icon="people" tone="accent" />
            <StatTile
              span={6}
              label={t('card.staffingUnits')}
              value={node.staffingCount}
              icon="staff"
              tone={node.staffingCount ? 'success' : 'neutral'}
              href={`/workspaces/${id}/objects/${objectId}/staffing`}
            />
            <StatTile
              span={6}
              label={t('card.shiftsToday')}
              value={todayShifts}
              icon="calendarCheck"
              tone={todayShifts ? 'success' : 'neutral'}
              href={`/workspaces/${id}/objects/${objectId}/shifts`}
            />
            <StatTile
              span={6}
              label={t('card.assets')}
              value={node.assetsCount}
              icon="wrench"
              tone={node.assetsCount ? 'accent' : 'neutral'}
              href={`/workspaces/${id}/objects/${objectId}/assets`}
            />
          </BentoGrid>
        </div>

        <Card span={12}>
          <CardHeader title={t('card.colleagues')} subtitle={t('card.colleaguesHint')} />
          {(roster?.length ?? 0) === 0 ? (
            <EmptyState icon="people" title={t('card.nobody')} description={t('card.nobodyHint')} />
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {(roster ?? []).map((r) => (
                <PersonChip key={r.userId} size="S" userId={r.userId} firstName={r.userName} role={r.positionName} />
              ))}
            </div>
          )}
        </Card>

        <Card span={12}>
          <CardHeader title={t('card.notes')} subtitle={t('card.notesHint')} />
          <NotesPanel target={{ type: 'branch', id: objectId }} scope={{ workspaceId: id }} />
        </Card>

        <Card span={12}>
          <CardHeader title={t('card.files')} subtitle={t('card.filesHint')} />
          {/* Два профиля: `document` не принимает картинки, `asset_photo` — только их.
              Оба разрешены движком для типа `branch`, поэтому секция берёт и фото
              зала, и PDF-схему. */}
          <AttachmentsSection
            files={files ?? []}
            canEdit={node.caps.manage}
            profile="document"
            imageProfile="asset_photo"
            onAttach={(f) => attach.mutate(f.id)}
            onRemove={(fileId) => detach.mutate(fileId)}
          />
        </Card>
      </BentoGrid>

      {editing && (
        <ObjectForm workspaceId={id} open node={node} onClose={() => setEditing(false)} onSaved={invalidate} />
      )}
      {confirmUI}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-3)', fontSize: '0.85rem', lineHeight: 1.6 }}>
      <span style={{ color: 'var(--on-surface-variant)', minWidth: 170 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}
