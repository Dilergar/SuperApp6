'use client';

// ============================================================
// Юрлица организации — список ТОО/ИП с реквизитами и счетами.
//
// Организация в SuperApp6 — это БРЕНД («Сеть кофеен Ромашка»); договор с
// работником и счёт подписывает конкретное ТОО. Головное юрлицо ровно одно:
// его реквизиты подставляются везде, где юрлицо не выбрано явно, архивировать
// его нельзя. Остальные — добавляются и уходят в архив (удаления нет: на них
// ссылаются трудовые карточки и напечатанные документы).
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEGAL_ENTITY_LIMITS, type LegalEntityDto } from '@superapp/shared';
import { EntitlementGauge, EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { Button, Card, CardHeader, Chip, EmptyState, Input, Modal, useConfirm } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';
import { legalEntitiesKey, workspaceRequisitesKey } from '@/lib/queries';
import { RequisitesEditor } from './RequisitesSection';
import { RevealScope } from '@/components/visibility/RevealButton';

import { toastApiError } from '@/lib/api-errors';
export function LegalEntitiesSection({ workspaceId, span = 12 }: { workspaceId: string; span?: number }) {
  const t = useTranslations('workspaces');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

  // Замок тарифа: на лимите кнопка выключена, чип объясняет (сервер всё равно ответит 402)
  const legalGate = useEntitlementGate('legalEntities.maxPerWorkspace', workspaceId, 'ent-lock-legal');
  const { data, isPending } = useQuery({
    queryKey: legalEntitiesKey(workspaceId, showArchived),
    queryFn: async () =>
      await apiGet<LegalEntityDto[]>(
        `/workspaces/${workspaceId}/legal-entities${showArchived ? '?archived=true' : ''}`,
      ),
  });

  const list = useMemo(() => data ?? [], [data]);
  const selected = list.find((e) => e.id === selectedId) ?? list[0] ?? null;

  const invalidateKeys = useMemo(
    () => [
      [...legalEntitiesKey(workspaceId, false)],
      [...legalEntitiesKey(workspaceId, true)],
      [...workspaceRequisitesKey(workspaceId)],
    ],
    [workspaceId],
  );
  const invalidate = () => {
    for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
  };

  const create = useMutation({
    mutationFn: async () => await apiPost<LegalEntityDto>(`/workspaces/${workspaceId}/legal-entities`, { name: newName.trim() }),
    onSuccess: (created) => {
      setCreating(false);
      setNewName('');
      setSelectedId(created.id);
      invalidate();
    },
    onError: (e) => toastApiError(e),
  });

  const archive = useMutation({
    mutationFn: (id: string) => apiPost(`/workspaces/${workspaceId}/legal-entities/${id}/archive`, {}),
    onSuccess: () => invalidate(),
    onError: (e) => toastApiError(e),
  });

  const restore = useMutation({
    mutationFn: (id: string) => apiPost(`/workspaces/${workspaceId}/legal-entities/${id}/restore`, {}),
    onSuccess: () => invalidate(),
    onError: (e) => toastApiError(e),
  });

  // Головное юрлицо подставляется везде, где оно не выбрано явно (реквизиты
  // организации, объекты без своего ТОО). Раньше сервер отвечал «сначала сделайте
  // головным другое», а кнопки для этого в интерфейсе не было вовсе.
  const makeHead = useMutation({
    mutationFn: (id: string) => apiPost(`/workspaces/${workspaceId}/legal-entities/${id}/make-head`, {}),
    onSuccess: () => invalidate(),
    onError: (e) => toastApiError(e),
  });

  if (isPending) return null;

  return (
    <>
      <Card span={span}>
        <CardHeader
          title={t('legalEntities.title')}
          subtitle={t('legalEntities.subtitle')}
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? t('legalEntities.hideArchive') : t('legalEntities.showArchive')}
              </Button>
              <EntitlementGauge keyName="legalEntities.maxPerWorkspace" workspaceId={workspaceId} />
              <EntitlementLock keyName="legalEntities.maxPerWorkspace" workspaceId={workspaceId} id="ent-lock-legal" />
              <Button
                size="sm"
                variant="outline"
                icon="add"
                disabled={legalGate.blocked}
                aria-describedby={legalGate.describedBy}
                onClick={() => setCreating(true)}
              >
                {t('legalEntities.add')}
              </Button>
            </>
          }
        />
        {list.length === 0 ? (
          <EmptyState
            icon="buildings"
            title={t('legalEntities.emptyTitle')}
            description={t('legalEntities.emptyDescription')}
            action={
              <Button variant="primary" icon="add" onClick={() => setCreating(true)}>
                {t('legalEntities.emptyAction')}
              </Button>
            }
          />
        ) : (
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            {list.map((e) => {
              const active = selected?.id === e.id;
              return (
                <div
                  key={e.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-3)',
                    flexWrap: 'wrap',
                    padding: 'var(--spacing-3)',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${active ? 'var(--primary)' : 'var(--outline-variant)'}`,
                    background: active ? 'var(--surface-container)' : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    style={{
                      flex: 1,
                      minWidth: 200,
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{e.name}</div>
                    <div className="label-sm" style={{ opacity: 0.7 }}>
                      {[e.legalName, e.bin ? t('legalEntities.binShort', { bin: e.bin }) : null]
                        .filter(Boolean)
                        .join(' · ') || t('legalEntities.noRequisites')}
                    </div>
                  </button>
                  {e.isHead && <Chip tone="success">{t('legalEntities.head')}</Chip>}
                  {e.archivedAt && <Chip tone="neutral">{t('legalEntities.archived')}</Chip>}
                  {!e.isHead && !e.archivedAt && (
                    // Архивное головным не делают — сервер отвечает 409, поэтому
                    // кнопка живёт только у живых юрлиц.
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="star"
                      loading={makeHead.isPending}
                      onClick={() =>
                        confirm(
                          {
                            title: t('legalEntities.makeHeadTitle'),
                            message: t('legalEntities.makeHeadMessage', { name: e.name }),
                            confirmLabel: t('legalEntities.makeHead'),
                          },
                          () => makeHead.mutateAsync(e.id).then(() => undefined),
                        )
                      }
                    >
                      {t('legalEntities.makeHead')}
                    </Button>
                  )}
                  {!e.isHead &&
                    (e.archivedAt ? (
                      <Button size="sm" variant="ghost" loading={restore.isPending} onClick={() => restore.mutate(e.id)}>
                        {t('legalEntities.restore')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          confirm(
                            {
                              title: t('legalEntities.archiveTitle'),
                              message: t('legalEntities.archiveMessage', { name: e.name }),
                              confirmLabel: t('legalEntities.archive'),
                            },
                            () => archive.mutateAsync(e.id).then(() => undefined),
                          )
                        }
                      >
                        {t('legalEntities.archive')}
                      </Button>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {selected && (
        <RevealScope>
          <RequisitesEditor
            key={selected.id}
            workspaceId={workspaceId}
            initial={selected}
            span={span}
            basePath={`/workspaces/${workspaceId}/legal-entities/${selected.id}`}
            invalidateKeys={invalidateKeys}
            title={t('requisites.forEntity', { name: selected.name })}
            subtitle={t('requisites.entitySubtitle')}
            nameField={
              selected.isHead
                ? undefined
                : {
                    value: names[selected.id] ?? selected.name,
                    onChange: (v) => setNames((prev) => ({ ...prev, [selected.id]: v })),
                  }
            }
            headerExtra={selected.isHead ? <Chip tone="success">{t('legalEntities.head')}</Chip> : undefined}
          />
        </RevealScope>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title={t('legalEntities.newTitle')}>
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <Input
            label={t('legalEntities.newName')}
            placeholder={t('legalEntities.newNamePlaceholder')}
            maxLength={LEGAL_ENTITY_LIMITS.nameMaxLength}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            hint={t('legalEntities.newNameHint')}
          />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCreating(false)}>{tc('actions.cancel')}</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={newName.trim().length === 0}
              onClick={() => create.mutate()}
            >
              {tc('actions.create')}
            </Button>
          </div>
        </div>
      </Modal>
      {confirmUI}
    </>
  );
}
