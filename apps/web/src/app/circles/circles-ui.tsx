'use client';

// ============================================================
// «Моё окружение» — переиспользуемые куски интерфейса страницы.
// Все примитивы — из кита (DESIGN.md §7): своих кнопок, полей и чипов здесь нет.
// ============================================================

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Badge, Button, Card, Chip, Input, SegmentedControl, Skeleton,
} from '@/components/ui';
import { useTranslations } from 'next-intl';
import { EntitySelector } from '@/components/EntitySelector';
import type { EntityOption, Principal } from '@/lib/entities';
import { apiPatch } from '@/lib/api';
import { ROLE_PRESET_KEYS } from '@superapp/shared';
import type {
  CalendarAccessLevel,
  CardVisibility,
  Circle,
  InvitationStatus,
} from '@superapp/shared';
import { PersonAvatar } from '../messenger/messenger-ui';
import {
  GROUP_COLORS, INVITATION_EXPIRY_WARN_DAYS, VIS_FIELDS, daysUntil, runAction, type VisField,
} from './circles-lib';

/** Одна сетка карточек на грид и на его скелетон — иначе они разъезжаются. */
export const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: 'var(--spacing-6)',
  alignItems: 'start',
};

// ============================================================
// Свёртка раздела («Приглашения», «Заблокированные»)
// ============================================================

/**
 * Заголовок-свёртка. Раньше это была самодельная кнопка с инлайновыми стилями и
 * стрелкой-символом «▲/▼»: без `aria-expanded` скринридер не знал, раскрыт
 * раздел или нет, а «▲» он читает как «указывающий вверх треугольник».
 */
export function CollapseHeader({
  open, onToggle, title, count, countTone = 'accent',
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  count: number;
  countTone?: 'accent' | 'neutral';
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-expanded={open}
      iconRight={open ? 'caretUp' : 'caretDown'}
      style={{ paddingLeft: 0 }}
    >
      <Badge tone={countTone}>{count}</Badge>
      {title}
    </Button>
  );
}

// ============================================================
// Выбор ролей связи
// ============================================================

/**
 * Роль, которую одна сторона даёт другой. Пресеты — чипы-фильтры кита
 * (`aria-pressed` кит выставляет сам), «Свой вариант» открывает поле ввода.
 *
 * Обёртка `role="group"` с подписью: подпись здесь относится к НАБОРУ чипов, а
 * не к одному полю, поэтому настоящий `<label>` был бы «висячим» — ни с чем не
 * связанным (ровно то, что запрещает DESIGN.md §7).
 */
export function RolePicker({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations('circles');
  const [showCustom, setShowCustom] = useState(false);
  // Подсказки — слова каталога, а сама роль связи остаётся ДАННЫМИ: «своим»
  // считаем всё, чего нет среди переведённых подсказок текущего языка.
  const presets = ROLE_PRESET_KEYS.map((key) => t(`rolePreset.${key}`));
  const isCustom = showCustom || (value !== '' && !presets.includes(value));

  return (
    <div role="group" aria-label={label}>
      <Card small>
        <div className="ui-field-label">{label}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }}>
          {presets.map((preset) => (
            <Chip
              key={preset}
              size="sm"
              tone="accent"
              selected={!isCustom && value === preset}
              onClick={() => { onChange(preset); setShowCustom(false); }}
            >
              {preset}
            </Chip>
          ))}
          <Chip size="sm" tone="accent" icon="edit" selected={isCustom} onClick={() => { setShowCustom(true); onChange(''); }}>
            {t('rolePreset.custom')}
          </Chip>
        </div>
        {isCustom && (
          <Input
            aria-label={t('rolePreset.customAria', { label })}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('rolePreset.customPlaceholder')}
            autoFocus
            wrapClassName="mt-3"
          />
        )}
      </Card>
    </div>
  );
}

// ============================================================
// Палитра цвета Группы
// ============================================================

/**
 * Образцы цвета. Рисуются чипом кита с подменой `--tone-bg`/`--tone-border` —
 * ровно тот приём, которым DESIGN.md §1 велит подавать цвет-ДАННЫЕ: форма,
 * радиус и `aria-pressed` остаются системными, меняется только цвет.
 *
 * Подпись у каждого образца обязательна: раньше это были шесть пустых квадратных
 * кнопок подряд — безымянных для скринридера и недоступных с клавиатуры.
 *
 * Выбранный помечается галочкой, а НЕ цветом: цвет здесь занят самим образцом
 * (иначе невыбранные пришлось бы гасить в серый, и палитра перестала бы
 * показывать то, из чего человек выбирает).
 */
export function ColorPalette({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const t = useTranslations('circles');
  return (
    <div role="group" aria-label={t('color.groupAria')} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
      {GROUP_COLORS.map((c) => (
        <Chip
          key={c.value}
          size="sm"
          tone="accent"
          icon={value === c.value ? 'check' : undefined}
          selected={value === c.value}
          onClick={() => onChange(c.value)}
          style={{ '--tone-bg': c.value, '--tone-border': c.value } as CSSProperties}
        >
          {t(`color.${c.key}`)}
        </Chip>
      ))}
    </div>
  );
}

// ============================================================
// Выбор своих Групп (для приглашения и для принятия)
// ============================================================

/**
 * Мультивыбор Групп. Пикер сущностей — платформенный `EntitySelector`
 * (Принцип 1), список подаётся `options` из уже загруженного кэша Групп: свой
 * загрузчик сходил бы за теми же данными второй раз и мог отстать от правок.
 */
export function GroupSelectField({
  label, hint, groups, value, onChange,
}: {
  label: string;
  hint?: string;
  groups: Circle[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('circles');
  const options: EntityOption[] = useMemo(
    () => groups.map((g) => ({
      type: 'circle', id: g.id, title: g.name, icon: g.icon, color: g.color, count: g.membersCount,
    })),
    [groups],
  );
  const principals: Principal[] = useMemo(
    () => value.map((id) => ({ type: 'circle', id })),
    [value],
  );

  if (groups.length === 0) return null; // нечего выбирать — пустое поле только мешает

  return (
    <div role="group" aria-label={label}>
      <div className="ui-field-label">{label}</div>
      <EntitySelector
        types={['circle']}
        options={options}
        value={principals}
        onChange={(next) => onChange(next.filter((p) => p.type === 'circle').map((p) => p.id))}
        placeholder={t('groupModal.selectPlaceholder')}
      />
      {hint && <div className="ui-field-hint">{hint}</div>}
    </div>
  );
}

// ============================================================
// Карточка приглашения
// ============================================================

// «Ожидает ответа» — жёлтое ожидание (мяч на чужой стороне), «Принято» —
// зелёное. Отказ/отмена/истечение НЕ красные: красный в системе занят опасным
// действием, а это просто исход, а не беда (DESIGN.md §1).
const STATUS_TONE: Record<InvitationStatus, 'waiting' | 'success' | 'neutral'> = {
  pending: 'waiting',
  accepted: 'success',
  rejected: 'neutral',
  cancelled: 'neutral',
  expired: 'neutral',
};

export interface InvitationCardProps {
  direction: 'incoming' | 'outgoing';
  status: InvitationStatus;
  myRole: string | null;
  theirRole: string | null;
  theirName: string;
  theirUserId?: string | null;
  theirPhone: string;
  registered?: boolean;
  message: string | null;
  expiresAt: string;
  /** Сервер сам посчитал, можно ли отправить повторно (статус + кулдаун). */
  canResend?: boolean;
  busy?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
  onBlock?: () => void;
  onResend?: () => void;
}

export function InvitationCard({
  direction, status, myRole, theirRole, theirName, theirUserId, theirPhone,
  registered = true, message, expiresAt, canResend, busy,
  onAccept, onReject, onCancel, onBlock, onResend,
}: InvitationCardProps) {
  const t = useTranslations('circles');
  const isIncoming = direction === 'incoming';
  const left = daysUntil(expiresAt);
  const expiringSoon = left <= INVITATION_EXPIRY_WARN_DAYS;

  return (
    <Card small>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-3)' }}>
        <PersonAvatar userId={theirUserId} name={theirName} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title-sm">{theirName}</div>
          <div className="label-sm">{theirPhone}{!registered && t('invite.notRegistered')}</div>
        </div>
        {/* Направление — матовый чип, а не синее слово: синий в системе означает
            действие, и «Исходящее» читалось как ссылка. Оба направления
            нейтральные — это сторона, а не «хорошо»/«плохо». */}
        <Chip size="sm" tone="neutral" icon={isIncoming ? 'arrowLeft' : 'arrowRight'}>
          {isIncoming ? t('invite.incoming') : t('invite.outgoing')}
        </Chip>
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        {/* Роль — метка, поэтому чип. Раньше она была покрашенным словом без
            подложки, то есть по форме читалась как кнопка. */}
        {myRole && <Chip size="sm" tone="accent">{t('invite.myRoleChip', { role: myRole })}</Chip>}
        {theirRole && <Chip size="sm" tone="accent">{t('invite.theirRoleChip', { name: theirName, role: theirRole })}</Chip>}
      </div>

      {message && (
        <p className="body-sm" style={{ marginBottom: 'var(--spacing-3)', fontStyle: 'italic' }}>
          &ldquo;{message}&rdquo;
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        {status === 'pending' ? (
          <Chip size="sm" tone={expiringSoon ? 'warning' : 'neutral'} icon="clock">
            {left <= 0 ? t('invite.expiresToday') : t('invite.expiresIn', { days: t('daysLeft', { n: left }) })}
          </Chip>
        ) : (
          <Chip size="sm" tone={STATUS_TONE[status]}>{t(`invite.status.${status}`)}</Chip>
        )}

        <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          {isIncoming && onAccept && <Button size="sm" variant="primary" tone="success" onClick={onAccept}>{t('invite.accept')}</Button>}
          {isIncoming && onReject && <Button size="sm" variant="matte" tone="danger" onClick={onReject}>{t('invite.reject')}</Button>}
          {isIncoming && onBlock && (
            <Button size="sm" variant="outline" onClick={onBlock}
              title={t('invite.blockHint')}>
              {t('invite.block')}
            </Button>
          )}
          {!isIncoming && status === 'pending' && onCancel && (
            <Button size="sm" variant="matte" tone="danger" onClick={onCancel}>{t('invite.cancel')}</Button>
          )}
          {!isIncoming && canResend && onResend && (
            <Button size="sm" variant="outline" icon="replay" loading={busy} onClick={onResend}>
              {t('invite.resend')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// Видимость карточки для Группы
// ============================================================

/** Ступени доступа к календарю; слова — `circles.calAccess.<key>`. */
const CAL_LEVEL_KEYS: CalendarAccessLevel[] = ['none', 'busy', 'detailed'];

export function GroupVisibilityEditor({
  group, onSaved,
}: {
  group: Circle;
  onSaved: (c: Circle) => void;
}) {
  const t = useTranslations('circles');
  const [vis, setVis] = useState<CardVisibility>(group.cardVisibility);
  const [cal, setCal] = useState<CalendarAccessLevel>(group.calendarVisibility ?? 'none');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Последнее ПОДТВЕРЖДЁННОЕ сервером состояние — цель отката. Без него отказ
  // сервера оставлял бы тумблер включённым, и интерфейс врал бы о приватности:
  // человек уверен, что открыл поле группе, а на деле поле закрыто.
  const savedVis = useRef<CardVisibility>(group.cardVisibility);
  const savedCal = useRef<CalendarAccessLevel>(group.calendarVisibility ?? 'none');

  // Снятие debounce-таймера при размонтировании: панель пересоздаётся при смене
  // группы (key), и висящий таймер записал бы видимость УЖЕ ЗАКРЫТОЙ группы.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setCalLevel = async (lvl: CalendarAccessLevel) => {
    const prev = savedCal.current;
    setCal(lvl);
    const ok = await runAction(async () => {
      const updated = await apiPatch<Circle>(`/circles/${group.id}`, { calendarVisibility: lvl });
      savedCal.current = lvl;
      onSaved(updated);
    }, t('groupVis.calendarSaved'));
    if (!ok) setCal(prev);
  };

  const toggle = (key: VisField, value: boolean) => {
    const next = { ...vis, [key]: value };
    setVis(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        const ok = await runAction(async () => {
          const updated = await apiPatch<Circle>(`/circles/${group.id}`, { cardVisibility: next });
          savedVis.current = next;
          onSaved(updated);
        }, t('groupVis.saved'));
        if (!ok) setVis(savedVis.current);
      })();
    }, 600);
  };

  return (
    <Card small style={{ marginBottom: 'var(--spacing-5)' }}>
      <div className="title-sm">{t('groupVis.title', { name: group.name })}</div>
      <p className="label-sm" style={{ margin: 'var(--spacing-1) 0 var(--spacing-3)' }}>
        {t('groupVis.hint')}
      </p>
      {/* Чипы-переключатели кита: выбранный = поле видно группе, невыбранный =
          скрыто. Состояние несут форма и иконка глаза, `aria-pressed` кит
          выставляет сам — сокращений «вид./скр.» в подписи больше нет. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
        {VIS_FIELDS.map((field) => {
          const on = vis[field];
          const label = t(`visField.${field}`);
          return (
            <Chip
              key={field}
              tone="accent"
              icon={on ? 'eye' : 'eyeOff'}
              selected={on}
              onClick={() => toggle(field, !on)}
              title={on ? t('groupVis.fieldShown', { label }) : t('groupVis.fieldHidden', { label })}
            >
              {label}
            </Chip>
          );
        })}
      </div>

      <div style={{ marginTop: 'var(--spacing-4)' }}>
        <div className="title-sm" style={{ fontSize: '0.9rem' }}>{t('groupVis.calendarTitle')}</div>
        <p className="label-sm" style={{ margin: 'var(--spacing-1) 0 var(--spacing-2)' }}>
          {t('groupVis.calendarHint')}
        </p>
        <SegmentedControl
          aria-label={t('groupVis.calendarAria')}
          value={cal}
          onChange={setCalLevel}
          items={CAL_LEVEL_KEYS.map((key) => ({ key, label: t(`calAccess.${key}`) }))}
        />
      </div>
    </Card>
  );
}

// ============================================================
// Заглушка загрузки грида
// ============================================================

/** Шапка и фильтры уже нарисованы — ждёт только список людей. */
export function ContactsGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div style={GRID_STYLE} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={230} radius="var(--radius-card)" />
      ))}
    </div>
  );
}
