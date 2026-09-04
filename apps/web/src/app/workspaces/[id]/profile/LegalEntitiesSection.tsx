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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEGAL_ENTITY_LIMITS, type LegalEntityDto } from '@superapp/shared';
import { Button, Card, CardHeader, Chip, EmptyState, Input, Modal, useConfirm } from '@/components/ui';
import { apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { legalEntitiesKey, workspaceRequisitesKey } from '@/lib/queries';
import { RequisitesEditor } from './RequisitesSection';

export function LegalEntitiesSection({ workspaceId, span = 12 }: { workspaceId: string; span?: number }) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

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
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const archive = useMutation({
    mutationFn: (id: string) => apiPost(`/workspaces/${workspaceId}/legal-entities/${id}/archive`, {}),
    onSuccess: () => invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const restore = useMutation({
    mutationFn: (id: string) => apiPost(`/workspaces/${workspaceId}/legal-entities/${id}/restore`, {}),
    onSuccess: () => invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  // Головное юрлицо подставляется везде, где оно не выбрано явно (реквизиты
  // организации, объекты без своего ТОО). Раньше сервер отвечал «сначала сделайте
  // головным другое», а кнопки для этого в интерфейсе не было вовсе.
  const makeHead = useMutation({
    mutationFn: (id: string) => apiPost(`/workspaces/${workspaceId}/legal-entities/${id}/make-head`, {}),
    onSuccess: () => invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (isPending) return null;

  return (
    <>
      <Card span={span}>
        <CardHeader
          title="Юрлица"
          subtitle="ТОО и ИП организации: реквизиты, счета, стороны договоров. Головное подставляется по умолчанию"
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? 'Скрыть архив' : 'Показать архив'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                icon="add"
                disabled={list.length >= LEGAL_ENTITY_LIMITS.maxPerWorkspace}
                onClick={() => setCreating(true)}
              >
                Юрлицо
              </Button>
            </>
          }
        />
        {list.length === 0 ? (
          <EmptyState
            icon="buildings"
            title="Юрлиц пока нет"
            description="Добавьте ТОО или ИП — от его имени будут заключаться договоры"
            action={<Button variant="primary" icon="add" onClick={() => setCreating(true)}>Добавить юрлицо</Button>}
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
                      {[e.legalName, e.bin ? `БИН ${e.bin}` : null].filter(Boolean).join(' · ') || 'Реквизиты не заполнены'}
                    </div>
                  </button>
                  {e.isHead && <Chip tone="success">Головное</Chip>}
                  {e.archivedAt && <Chip tone="neutral">В архиве</Chip>}
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
                            title: 'Сделать головным?',
                            message: `Реквизиты «${e.name}» будут подставляться везде, где юрлицо не выбрано явно. Прежнее головное останется в списке обычным.`,
                            confirmLabel: 'Сделать головным',
                          },
                          () => makeHead.mutateAsync(e.id).then(() => undefined),
                        )
                      }
                    >
                      Сделать головным
                    </Button>
                  )}
                  {!e.isHead &&
                    (e.archivedAt ? (
                      <Button size="sm" variant="ghost" loading={restore.isPending} onClick={() => restore.mutate(e.id)}>
                        Вернуть
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          confirm(
                            {
                              title: 'В архив?',
                              message: `«${e.name}» перестанет предлагаться в новых договорах и объектах. Существующие записи сохранятся.`,
                              confirmLabel: 'В архив',
                            },
                            () => archive.mutateAsync(e.id).then(() => undefined),
                          )
                        }
                      >
                        В архив
                      </Button>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {selected && (
        <RequisitesEditor
          key={selected.id}
          workspaceId={workspaceId}
          initial={selected}
          span={span}
          basePath={`/workspaces/${workspaceId}/legal-entities/${selected.id}`}
          invalidateKeys={invalidateKeys}
          title={`Реквизиты — ${selected.name}`}
          subtitle="Юрформа, БИН, банк, директор: подставляются в договоры и счета этого юрлица"
          nameField={
            selected.isHead
              ? undefined
              : {
                  value: names[selected.id] ?? selected.name,
                  onChange: (v) => setNames((prev) => ({ ...prev, [selected.id]: v })),
                }
          }
          headerExtra={selected.isHead ? <Chip tone="success">Головное</Chip> : undefined}
        />
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Новое юрлицо">
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <Input
            label="Название"
            placeholder="ТОО «Ромашка-Юг»"
            maxLength={LEGAL_ENTITY_LIMITS.nameMaxLength}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            hint="Реквизиты заполните после создания"
          />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCreating(false)}>Отмена</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={newName.trim().length === 0}
              onClick={() => create.mutate()}
            >
              Создать
            </Button>
          </div>
        </div>
      </Modal>
      {confirmUI}
    </>
  );
}
