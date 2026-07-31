'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Alert, Button, Card, Chip, EmojiIcon, IconButton, TickBar,
  type IconName, type Tone,
} from '@/components/ui';
import type { RichCardPayload, RichCardAction } from '@superapp/shared';
import { executeRichCardAction } from '@/lib/messenger-api';
import { ShareCardModal } from './ShareCardModal';

// ============================================================
// Rich Card (Ф3) — интерактивная карточка сервиса в ленте сообщений.
// Универсальна: всё рисуется из RichCardPayload (заказ / лот / сбор /
// задача / событие / финансы / встреча). Кнопка шлёт ключ действия на
// сервер, тот перепроверяет права и возвращает ОБНОВЛЁННУЮ карточку —
// её кладём на место через onActionDone.
//
// Оформление — Organic Bento (DESIGN.md): блок #fafbf8 с несущим
// 1px-бордером (карточка лежит НА белом блоке чата, тень её там не
// отделяет), радиус панели, эмодзи сервиса в матовом квадрате,
// прогресс — фирменный штриховой. Все примитивы — из кита.
// ============================================================

export function RichCardWidget({
  payload,
  onActionDone,
}: {
  payload: RichCardPayload;
  /** Отдаём свежую карточку наверх, чтобы родитель заменил payload сообщения в кэше. */
  onActionDone?: (updatedCard: RichCardPayload) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteIsError, setNoteIsError] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const runAction = async (action: RichCardAction) => {
    if (busyKey) return;
    setBusyKey(action.key);
    setNote(null);
    setNoteIsError(false);
    try {
      const result = await executeRichCardAction(action.key, payload.ref, action.payload);
      onActionDone?.(result.card);
      if (result.message) {
        setNote(result.message);
        setNoteIsError(false);
      }
    } catch (e) {
      setNote(errMsg(e));
      setNoteIsError(true);
    } finally {
      setBusyKey(null);
    }
  };

  const progress = payload.progress;
  const pct =
    progress && progress.target > 0
      ? Math.min(100, Math.round((progress.current / progress.target) * 100))
      : 0;
  const tone = statusTone(payload.status);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '0.3rem 0' }}>
      <Card
        small
        style={{
          width: '100%',
          maxWidth: '80%',
          border: '1px solid var(--border)',
        }}
      >
        {/* Шапка: эмодзи сервиса + заголовок (+ статус-чип) + подпись */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-3)' }}>
          {/* Эмодзи из БД — данные, не иконка (DESIGN.md §3): матовый квадрат.
              Нет эмодзи — подставляется иконка типа карточки. */}
          <EmojiIcon
            emoji={payload.icon}
            size={38}
            square
            tone={tone}
            fallback={CARD_TYPE_ICON[payload.cardType] ?? 'folder'}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {payload.href ? (
                <Link
                  href={payload.href}
                  className="title-sm"
                  style={{ color: 'var(--primary-dim)', textDecoration: 'none' }}
                >
                  {payload.title}
                </Link>
              ) : (
                <span className="title-sm">{payload.title}</span>
              )}
              {payload.status && <Chip size="sm" tone={tone}>{payload.status}</Chip>}
            </div>
            {payload.subtitle && (
              <p className="body-sm" style={{ margin: '0.125rem 0 0', color: 'var(--on-surface-variant)' }}>
                {payload.subtitle}
              </p>
            )}
          </div>
          <IconButton
            icon="share"
            label="Поделиться карточкой"
            size={32}
            onClick={() => setShowShare(true)}
            style={{ flexShrink: 0, marginTop: -2 }}
          />
        </div>

        {/* Картинка лота */}
        {payload.imageUrl && (
          <img
            src={payload.imageUrl}
            alt={payload.title}
            loading="lazy"
            decoding="async"
            style={{
              width: '100%',
              maxHeight: '11rem',
              objectFit: 'cover',
              borderRadius: 'var(--radius-md)',
              marginTop: 'var(--spacing-3)',
            }}
          />
        )}

        {/* Поля «подпись → значение» */}
        {payload.fields.length > 0 && (
          <div style={{ marginTop: 'var(--spacing-3)', borderTop: '1px solid var(--divider)', paddingTop: 'var(--spacing-2)' }}>
            {payload.fields.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 'var(--spacing-3)',
                  padding: '0.1875rem 0',
                }}
              >
                <span className="label-sm" style={{ color: 'var(--muted)' }}>{f.label}</span>
                <span
                  style={{
                    fontSize: '0.8125rem',
                    fontWeight: 700,
                    textAlign: 'right',
                    wordBreak: 'break-word',
                  }}
                >
                  {f.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Прогресс (сбор средств) — фирменный штриховой, сплошных полос в системе нет */}
        {progress && (
          <TickBar
            value={pct}
            tone={pct >= 100 ? 'success' : 'accent'}
            label={progress.label ?? `${progress.current} / ${progress.target}`}
            showValue
            style={{ marginTop: 'var(--spacing-3)' }}
          />
        )}

        {/* Итог действия или ошибка */}
        {note && (
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <Alert tone={noteIsError ? 'danger' : 'success'} onClose={() => setNote(null)}>
              {note}
            </Alert>
          </div>
        )}

        {/* Кнопки действий: цвет по смыслу (DESIGN.md §1) */}
        {payload.actions.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--spacing-2)',
              marginTop: 'var(--spacing-3)',
            }}
          >
            {payload.actions.map((action) => (
              <Button
                key={action.key}
                size="sm"
                variant={action.style === 'primary' ? 'primary' : 'matte'}
                tone={ACTION_TONE[action.style ?? 'default']}
                loading={busyKey === action.key}
                disabled={busyKey != null && busyKey !== action.key}
                onClick={() => runAction(action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </Card>

      {showShare && (
        <ShareCardModal
          refType={payload.ref.type}
          refId={payload.ref.id}
          title={payload.title}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

const CARD_TYPE_ICON: Record<string, IconName> = {
  order: 'receipt',
  listing: 'gift',
  crowdfunding: 'target',
  task: 'checkCircle',
  event: 'calendar',
  fin_transaction: 'coins',
  fin_month: 'chart',
  office_room: 'office',
};

/**
 * Основное действие — зелёное (Купить/Принять/Подтвердить), разрушающее —
 * красное, но МАТОВОЕ: сплошной красный блок в ленте сообщений кричит,
 * а «Отклонить» здесь стоит рядом с обычными кнопками.
 */
const ACTION_TONE: Record<string, Tone> = {
  primary: 'success',
  danger: 'danger',
  default: 'neutral',
};

/**
 * Тон статуса. В payload приходит уже готовое СЛОВО (сервер сам его строит),
 * поэтому сверяемся со словарями провайдеров: задачи, заказы, RSVP календаря,
 * встречи офиса. Незнакомое слово → нейтральный чип, а не выдуманный цвет.
 */
const STATUS_TONE: Record<string, Tone> = {
  // задачи
  'к выполнению': 'neutral',
  'в работе': 'accent',
  'на проверке': 'warning',
  'выполнена': 'success',
  'отменена': 'danger',
  // заказы и сборы
  'идёт сбор': 'accent',
  'ожидает подтверждения': 'warning',
  'завершён': 'success',
  'отклонён': 'danger',
  'отменён': 'danger',
  'возвращён': 'danger',
  // календарь
  'организатор': 'accent',
  'не ответил(а)': 'warning',
  'иду': 'success',
  'не иду': 'danger',
  'возможно': 'warning',
  // виртуальный офис
  'встреча': 'accent',
  'завершена': 'neutral',
};

function statusTone(status?: string | null): Tone {
  if (!status) return 'accent';
  const key = status.trim().toLowerCase();
  // «Идёт сейчас · 3» — счётчик в хвосте, поэтому по началу строки
  if (key.startsWith('идёт сейчас')) return 'success';
  return STATUS_TONE[key] ?? 'neutral';
}

function errMsg(e: unknown, fallback = 'Не удалось выполнить'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  const m = ax?.response?.data?.message || ax?.response?.data?.error;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
}
