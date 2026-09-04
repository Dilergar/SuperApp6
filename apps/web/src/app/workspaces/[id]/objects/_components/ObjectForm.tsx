'use client';

// ============================================================
// Форма объекта: обязательны только название и вид. Родитель — EntitySelector
// по объектам, управляющий — по должностям, юрлицо — Select с явным
// «как у родителя». Часовой пояс предзаполнен поясом родителя/организации.
//
// Правила смен (`scheduleSettings`) — ДАННЫЕ объекта, а не константы кода: отдых
// между сменами, потолок смены, допуск опоздания и начало недели у круглосуточного
// склада и у кофейни разные. Сервер мержит присланное поверх текущего.
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_SCHEDULE_SETTINGS,
  OBJECT_KINDS,
  OBJECT_LIMITS,
  type LegalEntityLiteDto,
  type ObjectNodeDto,
} from '@superapp/shared';
import { Button, Divider, GlyphField, Input, Modal, Select, Textarea } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { hoursLabel, KZ_TIME_ZONES } from '@/lib/objects-time';
import { legalEntitiesLiteKey, objectKey, objectsMineKey, objectsTreeKey } from '@/lib/queries';
import { fetchLegalEntitiesLite, objectsApi } from '../objects-api';

const KIND_OPTIONS = OBJECT_KINDS.map((k) => ({ value: k.value, label: k.label }));

/** 1 = понедельник (ISO). Схема допускает 0–6, но в жизни выбирают из двух. */
const WEEK_START_OPTIONS = [
  { value: '1', label: 'С понедельника' },
  { value: '0', label: 'С воскресенья' },
];

/** Минуты из поля: пустое и мусор оставляют прежнее значение (не 0). */
function minutesOr(raw: string, fallback: number): number {
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

export function ObjectForm({
  workspaceId,
  open,
  onClose,
  /** Правка существующего объекта; пусто — создание */
  node,
  /** Предзаполненный родитель при создании */
  parent,
  onSaved,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  node?: ObjectNodeDto | null;
  parent?: ObjectNodeDto | null;
  onSaved?: (node: ObjectNodeDto) => void;
}) {
  const qc = useQueryClient();
  const editing = !!node;

  const [name, setName] = useState(node?.name ?? '');
  const [kind, setKind] = useState<string>(node?.kind ?? (parent ? 'building' : 'site'));
  const [address, setAddress] = useState(node?.address ?? '');
  const [note, setNote] = useState(node?.note ?? '');
  const [glyph, setGlyph] = useState<string | null>(node?.glyph ?? null);
  const [timeZone, setTimeZone] = useState(node?.timeZone ?? parent?.timeZone ?? 'Asia/Almaty');
  const [legalEntityId, setLegalEntityId] = useState(node?.legalEntityId ?? '');
  const [parentSel, setParentSel] = useState<{ type: 'branch'; id: string }[]>(
    node?.parentId
      ? [{ type: 'branch', id: node.parentId }]
      : parent
        ? [{ type: 'branch', id: parent.id }]
        : [],
  );
  const [headSel, setHeadSel] = useState<{ type: 'position'; id: string }[]>(
    node?.headPositionId ? [{ type: 'position', id: node.headPositionId }] : [],
  );

  // Правила смен: у нового объекта — платформенные дефолты, у существующего — его
  // собственные (сервер уже отдал их слитыми с дефолтами).
  const rules = node?.scheduleSettings ?? DEFAULT_SCHEDULE_SETTINGS;
  const [minRest, setMinRest] = useState(String(rules.minRestMin));
  const [maxShift, setMaxShift] = useState(String(rules.maxShiftMin));
  const [lateTolerance, setLateTolerance] = useState(String(rules.lateToleranceMin));
  const [weekStartsOn, setWeekStartsOn] = useState(String(rules.weekStartsOn));

  // Пояс объекта может быть заведён вне списка Казахстана (старая запись, филиал
  // за рубежом) — тогда он остаётся в выборе отдельной строкой, а не пропадает.
  const tzOptions = useMemo(() => {
    const base = KZ_TIME_ZONES.map((z) => ({ value: z.value, label: z.label }));
    return base.some((o) => o.value === timeZone) ? base : [...base, { value: timeZone, label: timeZone }];
  }, [timeZone]);

  const { data: legalEntities } = useQuery({
    queryKey: legalEntitiesLiteKey(workspaceId),
    queryFn: () => fetchLegalEntitiesLite(workspaceId),
    enabled: open,
  });

  const legalOptions = useMemo(
    () => [
      { value: '', label: 'Как у родителя / головное' },
      ...((legalEntities ?? []) as LegalEntityLiteDto[]).map((l) => ({
        value: l.id,
        label: l.isHead ? `${l.name} (головное)` : l.name,
      })),
    ],
    [legalEntities],
  );

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: objectsTreeKey(workspaceId, false) });
    void qc.invalidateQueries({ queryKey: objectsTreeKey(workspaceId, true) });
    void qc.invalidateQueries({ queryKey: objectsMineKey(workspaceId) });
    if (node) void qc.invalidateQueries({ queryKey: objectKey(workspaceId, node.id) });
  };

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        address: address.trim() || null,
        note: note.trim() || null,
        glyph,
        timeZone,
        legalEntityId: legalEntityId || null,
        headPositionId: headSel[0]?.id ?? null,
        scheduleSettings: {
          minRestMin: minutesOr(minRest, rules.minRestMin),
          maxShiftMin: minutesOr(maxShift, rules.maxShiftMin),
          lateToleranceMin: minutesOr(lateTolerance, rules.lateToleranceMin),
          weekStartsOn: Number(weekStartsOn),
        },
      };
      if (!editing) {
        body.parentId = parentSel[0]?.id ?? null;
        return await objectsApi.create(workspaceId, body);
      }
      const saved = await objectsApi.update(workspaceId, node!.id, body);
      // Перенос — ОТДЕЛЬНАЯ операция: она пересчитывает предков поддерева и
      // пересобирает права, поэтому её нельзя прятать внутрь PATCH полей.
      const nextParent = parentSel[0]?.id ?? null;
      if (nextParent !== (node!.parentId ?? null)) {
        return await objectsApi.move(workspaceId, node!.id, nextParent);
      }
      return saved;
    },
    onSuccess: (saved) => {
      invalidate();
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  // Границы правил — те же, что в Zod-схеме сервера: поле не должно уметь
  // отправить то, что сервер отвергнет.
  const minRestVal = minutesOr(minRest, rules.minRestMin);
  const maxShiftVal = minutesOr(maxShift, rules.maxShiftMin);
  const lateVal = minutesOr(lateTolerance, rules.lateToleranceMin);
  const minRestError = minRestVal > 1440 ? 'Не больше 1440 минут (сутки)' : null;
  const maxShiftError = maxShiftVal < 60 || maxShiftVal > 1440 ? 'От 60 до 1440 минут' : null;
  const lateError = lateVal > 240 ? 'Не больше 240 минут' : null;
  const rulesInvalid = !!(minRestError || maxShiftError || lateError);

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Объект' : 'Новый объект'} size="lg">
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Input
            label="Название"
            placeholder="Кофейня на Абая"
            maxLength={OBJECT_LIMITS.nameMaxLength}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Select label="Вид" value={kind} onChange={setKind} options={KIND_OPTIONS} />
        </div>

        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            Внутри объекта
          </span>
          <EntitySelector
            types={['branch']}
            context={{ workspaceId }}
            value={parentSel}
            onChange={(next) => setParentSel(next.slice(-1) as { type: 'branch'; id: string }[])}
            placeholder="Верхний уровень"
          />
        </div>

        <Input
          label="Адрес"
          placeholder="г. Алматы, пр. Абая, 10"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />

        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Select
            label="Часовой пояс"
            hint="Смены и «сегодня» считаются в поясе объекта"
            value={timeZone}
            onChange={setTimeZone}
            options={tzOptions}
          />
          <Select
            label="Юрлицо"
            value={legalEntityId}
            onChange={setLegalEntityId}
            options={legalOptions}
          />
        </div>

        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <div>
            <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
              Управляющая должность
            </span>
            <EntitySelector
              types={['position']}
              context={{ workspaceId }}
              value={headSel}
              onChange={(next) => setHeadSel(next.slice(-1) as { type: 'position'; id: string }[])}
              placeholder="Не задана"
            />
          </div>
          <GlyphField label="Значок" value={glyph} onChange={setGlyph} />
        </div>

        <Textarea label="Заметка" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />

        <Divider />

        <div>
          <span className="label-sm" style={{ display: 'block', fontWeight: 600 }}>
            Правила смен
          </span>
          <p className="body-sm" style={{ margin: '0.25rem 0 var(--spacing-3)' }}>
            По ним проверяются график и факт выходов этого объекта.
          </p>
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
            <Input
              label="Отдых между сменами, мин"
              inputMode="numeric"
              hint={hoursLabel(minRestVal)}
              error={minRestError}
              value={minRest}
              onChange={(e) => setMinRest(e.target.value)}
            />
            <Input
              label="Максимум смены, мин"
              inputMode="numeric"
              hint={hoursLabel(maxShiftVal)}
              error={maxShiftError}
              value={maxShift}
              onChange={(e) => setMaxShift(e.target.value)}
            />
            <Input
              label="Допуск опоздания, мин"
              inputMode="numeric"
              hint="В пределах допуска выход считается вовремя"
              error={lateError}
              value={lateTolerance}
              onChange={(e) => setLateTolerance(e.target.value)}
            />
            <Select
              label="Начало недели"
              value={weekStartsOn}
              onChange={setWeekStartsOn}
              options={WEEK_START_OPTIONS}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            icon="save"
            loading={save.isPending}
            disabled={name.trim().length === 0 || rulesInvalid}
            onClick={() => save.mutate()}
          >
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
