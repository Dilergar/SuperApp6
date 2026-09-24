'use client';

// ============================================================
// «Кто видит» ОДНО личное поле карточки (core/visibility, §5.10 A.2):
// `Все · Окружение · Группы… · Никто` + «и коллеги» (люди из общих организаций) + исключения
// по людям. Чистый редактор значения: сохраняет вызывающий (автосейв с откатом к
// подтверждённому сервером состоянию).
//
// «Группы…» без выбранной Группы ничего не сохраняет (это было бы «Никто») — режим живёт
// локально, пока человек не выберет хотя бы одну Группу.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PersonalVisibilityFieldDto, PersonalVisibilityFieldInput, VisibilityAudienceRef } from '@superapp/shared';
import { Button, Chip, SegmentedControl } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { ExceptionsModal } from './ExceptionsModal';

export type AudienceMode = 'everybody' | 'circle_all' | 'groups' | 'nobody';
export type PersonalAudience = PersonalVisibilityFieldInput['audiences'][number];

const MODES: readonly AudienceMode[] = ['everybody', 'circle_all', 'groups', 'nobody'];

export function audienceModeOf(a: readonly VisibilityAudienceRef[]): AudienceMode {
  if (a.some((x) => x.kind === 'everybody')) return 'everybody';
  if (a.some((x) => x.kind === 'circle_all')) return 'circle_all';
  if (a.some((x) => x.kind === 'circle')) return 'groups';
  return 'nobody';
}

/** Аудитории поля: режим + выбранные Группы + «и коллеги» (как было задано). */
export function audiencesFor(mode: AudienceMode, circleIds: readonly string[], colleagues: readonly VisibilityAudienceRef[]): PersonalAudience[] {
  if (mode === 'everybody') return [{ kind: 'everybody', id: null }];
  const base: PersonalAudience[] =
    mode === 'circle_all'
      ? [{ kind: 'circle_all', id: null }]
      : mode === 'groups'
        ? circleIds.map((id) => ({ kind: 'circle' as const, id }))
        : [];
  return [...base, ...colleagues.map((c) => ({ kind: 'colleagues' as const, id: c.id }))];
}

export interface AudienceChange {
  audiences: PersonalAudience[];
  always: string[];
  never: string[];
}

export function AudienceCell({
  field,
  label,
  onChange,
  disabled,
}: {
  field: PersonalVisibilityFieldDto;
  /** Подпись поля (для окна исключений и aria) */
  label: string;
  onChange: (next: AudienceChange) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('visibility');
  const [pendingGroups, setPendingGroups] = useState(false);
  const [exceptionsOpen, setExceptionsOpen] = useState(false);

  const serverMode = audienceModeOf(field.audiences);
  const mode: AudienceMode = pendingGroups && serverMode !== 'groups' ? 'groups' : serverMode;
  const circleIds = field.audiences.filter((a) => a.kind === 'circle' && a.id).map((a) => a.id as string);
  const colleagues = field.audiences.filter((a) => a.kind === 'colleagues');
  const exceptions = field.always.length + field.never.length;

  const emit = (audiences: PersonalAudience[]) => onChange({ audiences, always: field.always, never: field.never });

  const pickMode = (next: AudienceMode) => {
    if (next === 'groups') {
      // Группа ещё не выбрана — только показать выбор; «Группы» без Групп = «Никто»
      if (!circleIds.length) {
        setPendingGroups(true);
        return;
      }
    }
    setPendingGroups(false);
    emit(audiencesFor(next, circleIds, colleagues));
  };

  const toggleColleagues = () => {
    const next = colleagues.length ? [] : [{ kind: 'colleagues' as const, id: null }];
    emit(audiencesFor(mode === 'groups' && !circleIds.length ? 'nobody' : mode, circleIds, next));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--spacing-2)' }}>
        <SegmentedControl<AudienceMode>
          aria-label={t('personal.tableWho')}
          value={mode}
          onChange={disabled ? () => undefined : pickMode}
          items={MODES.map((key) => ({
            key,
            label: key === 'groups' ? t('audiences.groups') : t(`audiences.${key}`),
          }))}
        />
        {mode !== 'everybody' && (
          <Chip
            tone="accent"
            icon={colleagues.length ? 'check' : 'add'}
            selected={colleagues.length > 0}
            onClick={disabled ? undefined : toggleColleagues}
            title={t('personal.colleaguesHint')}
          >
            {t('audiences.colleagues')}
          </Chip>
        )}
        <Button variant="matte" size="sm" icon="people" onClick={() => setExceptionsOpen(true)} disabled={disabled}>
          {exceptions ? t('personal.exceptionsCount', { n: exceptions }) : t('personal.exceptions')}
        </Button>
      </div>
      {mode === 'groups' && (
        <EntitySelector
          types={['circle']}
          multi
          placeholder={t('personal.chooseGroups')}
          value={circleIds.map((id) => ({ type: 'circle', id }))}
          onChange={(next) => {
            const ids = next.map((p) => p.id);
            setPendingGroups(ids.length === 0);
            emit(audiencesFor(ids.length ? 'groups' : 'nobody', ids, colleagues));
          }}
        />
      )}
      <ExceptionsModal
        open={exceptionsOpen}
        onClose={() => setExceptionsOpen(false)}
        fieldLabel={label}
        always={field.always}
        never={field.never}
        onSave={(always, never) => {
          setExceptionsOpen(false);
          onChange({ audiences: field.audiences as PersonalAudience[], always, never });
        }}
      />
    </div>
  );
}
