'use client';

// ============================================================
// «Моя карточка и видимость» (core/visibility, §5.10 A) — ОДНО место «кто видит что обо мне»:
//  1. предпросмотр карточки глазами зрителя (Чужой · Моё окружение · Группа · Коллега в «…») —
//     ответ СЕРВЕРА (`GET /users/me/card-preview`), не эмуляция на клиенте;
//  2. таблица «Поле → Кто видит»: аудитории + исключения по людям, автосейв с откатом к
//     подтверждённому состоянию;
//  3. «Как меня находят» (находимость по номеру) — неотличимо от «не найден» для остальных.
// «Был в сети» живёт здесь же строкой таблицы (взаимность — в подсказке).
// ============================================================

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  DISCOVERABLE_BY,
  type DiscoverableBy,
  type PersonalVisibilityDto,
  type PersonalVisibilityFieldDto,
  type VisibilityPreviewQuery,
} from '@superapp/shared';
import { Button, Card, LoadingBlock, Select, Skeleton, Table, TableCell, TableHeader, TableRow } from '@/components/ui';
import { AudienceCell, type AudienceChange } from '@/components/visibility/AudienceCell';
import { PersonCard } from '../circles/PersonCard';
import type { CardSkinRender } from '../circles/card-skin';
import { fetchCardPreview, fetchMyVisibility, resetMyVisibility, setMyDiscoverability, updateMyVisibility } from '@/lib/visibility-api';
import { circlesKey, fetchCircles, fetchWorkspaces, visibilityMeKey, visibilityPreviewKey, workspacesKey } from '@/lib/queries';
import { toast, toastError } from '@/lib/toast';
import { toastApiError } from '@/lib/api-errors';

/** Порядок строк — от частого к редкому (§5.10 A.2); поле вне списка — в конец. */
const ROW_ORDER = ['phone', 'city', 'bio', 'socialLinks', 'birthDayMonth', 'birthYear', 'email', 'maritalStatus', 'avatar', 'presence'];
const ROW_HINTS: Record<string, 'personal.phoneHint' | 'personal.presenceHint'> = {
  phone: 'personal.phoneHint',
  presence: 'personal.presenceHint',
};

/** Кого изображает предпросмотр: `stranger` · `circle_all` · `circle:<id>` · `colleague:<wsId>`. */
function previewQuery(v: string): VisibilityPreviewQuery {
  const [as, id] = v.split(':');
  return (id ? { as, id } : { as }) as VisibilityPreviewQuery;
}

export function CardVisibilitySection({ skin }: { skin?: CardSkinRender }) {
  const t = useTranslations('visibility');
  const qc = useQueryClient();
  const me = useQuery({ queryKey: visibilityMeKey, queryFn: fetchMyVisibility, staleTime: 30_000 });
  const circles = useQuery({ queryKey: circlesKey, queryFn: fetchCircles, staleTime: 60_000 });
  const workspaces = useQuery({ queryKey: workspacesKey, queryFn: fetchWorkspaces, staleTime: 60_000 });

  const [previewAs, setPreviewAs] = useState('stranger');
  const pq = previewQuery(previewAs);
  const preview = useQuery({
    queryKey: visibilityPreviewKey(pq.as, pq.id ?? null),
    queryFn: () => fetchCardPreview(pq),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const previewOptions = useMemo(
    () => [
      { value: 'stranger', label: t('personal.previewStranger') },
      { value: 'circle_all', label: t('personal.previewCircle') },
      ...(circles.data ?? []).map((g) => ({ value: `circle:${g.id}`, label: t('personal.previewGroup', { name: g.name }) })),
      ...(workspaces.data ?? []).map((w) => ({ value: `colleague:${w.id}`, label: t('personal.previewColleague', { name: w.name }) })),
    ],
    [circles.data, workspaces.data, t],
  );

  const rows = useMemo(() => {
    const fields = me.data?.fields ?? [];
    const rank = (k: string) => (ROW_ORDER.includes(k) ? ROW_ORDER.indexOf(k) : ROW_ORDER.length);
    return [...fields].sort((a, b) => rank(a.fieldKey) - rank(b.fieldKey));
  }, [me.data]);

  const afterSave = (dto: PersonalVisibilityDto) => {
    qc.setQueryData(visibilityMeKey, dto);
    void qc.invalidateQueries({ queryKey: ['visibility', 'preview'] });
  };

  // Автосейв: сразу показать новое, при отказе — вернуть ПОДТВЕРЖДЁННОЕ сервером (иначе
  // интерфейс врал бы о приватности: человек уверен, что закрыл поле, а оно открыто)
  const saveField = async (field: PersonalVisibilityFieldDto, next: AudienceChange) => {
    const prev = qc.getQueryData<PersonalVisibilityDto>(visibilityMeKey);
    if (prev) {
      qc.setQueryData<PersonalVisibilityDto>(visibilityMeKey, {
        ...prev,
        fields: prev.fields.map((f) => (f.fieldKey === field.fieldKey ? { ...f, ...next, configured: true } : f)),
      });
    }
    try {
      const dto = await updateMyVisibility({
        fields: [{ fieldKey: field.fieldKey, audiences: next.audiences, always: next.always, never: next.never, hiddenFromCircles: field.hiddenFromCircles }],
      });
      afterSave(dto);
      toast(t('personal.saved'), 'success');
    } catch {
      if (prev) qc.setQueryData(visibilityMeKey, prev);
      toastError(t('personal.saveFailed'));
    }
  };

  const resetField = async (fieldKey: string) => {
    try {
      afterSave(await resetMyVisibility([fieldKey]));
      toast(t('personal.saved'), 'success');
    } catch (err) {
      toastApiError(err);
    }
  };

  const setDiscovery = async (value: DiscoverableBy) => {
    const prev = qc.getQueryData<PersonalVisibilityDto>(visibilityMeKey);
    if (prev) qc.setQueryData<PersonalVisibilityDto>(visibilityMeKey, { ...prev, discoverableBy: value });
    try {
      afterSave(await setMyDiscoverability(value));
      toast(t('personal.saved'), 'success');
    } catch {
      if (prev) qc.setQueryData(visibilityMeKey, prev);
      toastError(t('personal.saveFailed'));
    }
  };

  const fieldLabel = (key: string) => t(`types.user.card.fields.${key}.label`);

  return (
    <div>
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{t('personal.title')}</h2>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>{t('personal.subtitle')}</p>

      {/* 1. Предпросмотр глазами зрителя */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
        <span className="label-sm">{t('personal.previewAs')}</span>
        <Select aria-label={t('personal.previewAria')} value={previewAs} onChange={setPreviewAs} width={280} options={previewOptions} />
      </div>
      <div style={{ marginBottom: 'var(--spacing-8)' }}>
        {preview.data ? (
          <PersonCard mode="full" skin={skin} card={preview.data} caption={t('personal.previewNote')} />
        ) : preview.isError ? (
          // Предпросмотр не посчитан — НЕ подставлять свою полную карточку: она соврала бы,
          // что зритель видит всё
          <p className="label-sm" style={{ opacity: 0.7 }}>{t('why.error')}</p>
        ) : (
          <LoadingBlock />
        )}
      </div>

      {/* 2. Поле → Кто видит */}
      {me.isPending ? (
        <Skeleton height={320} radius="var(--radius-card)" />
      ) : (
        <Table
          lines
          aria-label={t('personal.title')}
          columns={[
            { key: 'field', label: t('personal.tableField'), width: 'minmax(9rem, 14rem)', hideOnMobile: true },
            { key: 'who', label: t('personal.tableWho') },
          ]}
        >
          <TableHeader />
          {rows.map((f) => {
            const label = fieldLabel(f.fieldKey);
            const hint = ROW_HINTS[f.fieldKey];
            return (
              <TableRow key={f.fieldKey}>
                <TableCell hideOnMobile>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
                    <span style={{ fontWeight: 600 }}>{label}</span>
                    {hint && <span className="label-sm" style={{ opacity: 0.7, whiteSpace: 'normal' }}>{t(hint)}</span>}
                    {f.configured && (
                      <Button variant="ghost" size="sm" icon="undo" onClick={() => void resetField(f.fieldKey)} style={{ alignSelf: 'flex-start' }}>
                        {t('personal.reset')}
                      </Button>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', width: '100%', minWidth: 0 }}>
                    {/* На узком экране колонка «Поле» скрыта — подпись едет в ячейку */}
                    <span className="md:hidden" style={{ fontWeight: 600 }}>{label}</span>
                    <AudienceCell field={f} label={label} onChange={(next) => void saveField(f, next)} />
                    {hint && <span className="label-sm md:hidden" style={{ opacity: 0.7, whiteSpace: 'normal' }}>{t(hint)}</span>}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
      )}

      {/* 3. Как меня находят */}
      <Card style={{ marginTop: 'var(--spacing-8)', maxWidth: 560 }}>
        <h3 className="title-md" style={{ margin: '0 0 var(--spacing-3)' }}>{t('personal.discoveryTitle')}</h3>
        <Select
          label={t('personal.discoveryLabel')}
          value={me.data?.discoverableBy ?? 'everybody'}
          onChange={(v) => void setDiscovery(v as DiscoverableBy)}
          disabled={!me.data}
          options={DISCOVERABLE_BY.map((v) => ({ value: v, label: t(`personal.discovery.${v}`) }))}
        />
        <p className="label-sm" style={{ margin: 'var(--spacing-2) 0 0', opacity: 0.7, lineHeight: 1.5 }}>{t('personal.discoveryHint')}</p>
      </Card>
    </div>
  );
}
