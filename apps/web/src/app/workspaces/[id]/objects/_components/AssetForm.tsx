'use client';

// Добавление оборудования. Обязательны только МОДЕЛЬ и НАЗВАНИЕ — остальное
// дозаполняется на карточке. Модель — комбокс: поиск по своим моделям плюс
// «Создать „…“» прямо из поля (справочник заводится на лету, но остаётся общим).
//
// Владение и цена покупки — управленческие ДЕНЬГИ: без `branch.payroll.view`
// сервер отвергает их с 403, поэтому форма их и не показывает.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { HOLDING_KINDS, type AssetModelDto } from '@superapp/shared';
import { Button, Chip, Input, Modal, SearchField, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { assetModelsKey } from '@/lib/queries';
import { assetsApi, fetchAssetModels } from '../objects-api';

function tengeToTiyn(v: string): string | null {
  const clean = v.replace(/\s/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * 100));
}

export function AssetForm({
  workspaceId,
  objectId,
  open,
  /** Право `branch.payroll.view` объекта: без него владение и цену не показываем */
  canSeeMoney = false,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  objectId: string;
  open: boolean;
  canSeeMoney?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [modelSearch, setModelSearch] = useState('');
  // Поиск моделей идёт в ключ запроса — без задержки каждая буква = запрос.
  const [modelQuery, setModelQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setModelQuery(modelSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [modelSearch]);

  const [modelId, setModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [inventoryNumber, setInventoryNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [holdingKind, setHoldingKind] = useState('owned');
  const [price, setPrice] = useState('');
  const [custodian, setCustodian] = useState<{ type: 'user'; id: string }[]>([]);

  const { data: models } = useQuery({
    queryKey: assetModelsKey(workspaceId, modelQuery),
    queryFn: () => fetchAssetModels(workspaceId, modelQuery || undefined),
    enabled: open,
  });

  const list = useMemo(() => (models as AssetModelDto[] | undefined) ?? [], [models]);
  const canCreateNew = modelSearch.trim().length > 1 && !list.some((m) => m.name.toLowerCase() === modelSearch.trim().toLowerCase());
  const chosenLabel = modelId ? (list.find((m) => m.id === modelId)?.name ?? 'Модель') : newModelName;

  const save = useMutation({
    mutationFn: async () => {
      if (!modelId && !newModelName) throw new Error('Выберите модель или создайте новую');
      const tiyn = tengeToTiyn(price);
      if (price.trim() && tiyn === null) throw new Error('Цена — это число, например 450 000');
      return assetsApi.create(workspaceId, objectId, {
        ...(modelId ? { modelId } : { newModel: { name: newModelName! } }),
        name: name.trim(),
        inventoryNumber: inventoryNumber.trim() || null,
        serialNumber: serialNumber.trim() || null,
        custodianUserId: custodian[0]?.id ?? null,
        // Денежное — только с правом: без него сервер отвечает 403 на само поле.
        ...(canSeeMoney ? { holdingKind, ...(tiyn ? { purchasePrice: tiyn } : {}) } : {}),
      });
    },
    onSuccess: () => {
      onSaved?.();
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title="Новое оборудование" size="lg">
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            Модель
          </span>
          {chosenLabel ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
              <Chip tone="accent">{chosenLabel}</Chip>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setModelId(null);
                  setNewModelName(null);
                }}
              >
                Изменить
              </Button>
            </div>
          ) : (
            <>
              <SearchField
                placeholder="Кофемашина Jura X8…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: 'var(--spacing-2)' }}>
                {list.slice(0, 8).map((m) => (
                  <Button key={m.id} size="sm" variant="ghost" onClick={() => setModelId(m.id)}>
                    {m.name}
                  </Button>
                ))}
                {canCreateNew && (
                  <Button size="sm" variant="outline" icon="add" onClick={() => setNewModelName(modelSearch.trim())}>
                    {`Создать «${modelSearch.trim()}»`}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>

        <Input
          label="Название"
          placeholder="Кофемашина у бара"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
          <Input label="Инвентарный номер" value={inventoryNumber} onChange={(e) => setInventoryNumber(e.target.value)} />
          <Input label="Серийный номер" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
        </div>

        {canSeeMoney && (
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
            <Select
              label="Владение"
              value={holdingKind}
              onChange={setHoldingKind}
              options={HOLDING_KINDS.map((h) => ({ value: h.value, label: h.label }))}
            />
            <Input
              label="Цена покупки"
              placeholder="450 000"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
        )}

        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            Ответственный
          </span>
          <EntitySelector
            types={['user']}
            context={{ workspaceId }}
            value={custodian}
            onChange={(next) => setCustodian(next.slice(-1) as { type: 'user'; id: string }[])}
            placeholder="Не назначен"
          />
        </div>

        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim() || (!modelId && !newModelName)}
            onClick={() => save.mutate()}
          >
            Добавить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
