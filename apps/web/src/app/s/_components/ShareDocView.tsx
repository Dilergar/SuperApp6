'use client';

// ============================================================
// Документ глазами гостя — только PDF-отпечаток текущего содержимого.
//
// Ни исходника, ни редактора: гость читает и печатает. Тот же отпечаток позже
// подписывает ЭДО, поэтому «что человек видел» и «что он подписал» — один и тот
// же документ.
// ============================================================

import { useEffect, useState } from 'react';
import type { ShareDocGuestView } from '@superapp/shared';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Feedback';

/**
 * Шаги опроса готовности отпечатка: часто вначале, реже дальше, всего около двух минут.
 * Список конечный намеренно — раньше страница спрашивала каждые 2.5 секунды БЕЗ предела,
 * и вкладка, забытая на ночь, давала десятки тысяч запросов, каждый из которых дёргал
 * конвертацию. Если за это время документ не подготовился, честнее сказать об этом и дать
 * кнопку, чем крутить спиннер вечно.
 */
const POLL_STEPS_MS = [2500, 2500, 2500, 5000, 5000, 5000, 10000, 10000, 15000, 15000, 15000, 15000];

export function ShareDocView({
  view,
  onRefresh,
}: {
  view: ShareDocGuestView;
  /** Перезапросить содержимое: отпечаток считается фоном, о готовности узнаём опросом */
  onRefresh: () => void;
}) {
  const [tries, setTries] = useState(0);
  const gaveUp = tries >= POLL_STEPS_MS.length;

  useEffect(() => {
    if (view.state !== 'preparing' || gaveUp) return;
    const t = setTimeout(() => {
      setTries((n) => n + 1);
      onRefresh();
    }, POLL_STEPS_MS[tries]);
    return () => clearTimeout(t);
  }, [view.state, tries, gaveUp, onRefresh]);

  // Документ подготовился (или его правят заново) — счётчик начинается сначала.
  useEffect(() => {
    if (view.state !== 'preparing') setTries(0);
  }, [view.state]);

  if (view.state === 'unavailable') {
    return (
      <div style={{ textAlign: 'center', padding: 'var(--spacing-6) 0' }}>
        <Icon name="warningCircle" size={28} style={{ color: 'var(--on-surface-variant)' }} />
        <p className="body-sm" style={{ margin: '0.5rem 0 0' }}>
          Просмотр документа сейчас недоступен. Попробуйте открыть ссылку позже.
        </p>
      </div>
    );
  }

  if (view.state === 'preparing' || !view.pdf) {
    if (gaveUp) {
      return (
        <div style={{ textAlign: 'center', padding: 'var(--spacing-6) 0' }}>
          <Icon name="warningCircle" size={28} style={{ color: 'var(--on-surface-variant)' }} />
          <p className="body-sm" style={{ margin: '0.5rem 0 var(--spacing-4)' }}>
            Документ готовится дольше обычного.
          </p>
          <Button
            onClick={() => {
              setTries(0);
              onRefresh();
            }}
          >
            Проверить снова
          </Button>
        </div>
      );
    }
    return (
      <div style={{ textAlign: 'center', padding: 'var(--spacing-6) 0' }}>
        <Spinner />
        <p className="body-sm" style={{ margin: 'var(--spacing-4) 0 0' }}>
          Готовим документ к просмотру…
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          height: 'min(70vh, 720px)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
          background: 'var(--surface-container)',
        }}
      >
        {/* PDF отдаётся с Content-Disposition: inline, поэтому браузер рисует его сам */}
        <iframe src={view.pdf.url} title={view.title} style={{ width: '100%', height: '100%', border: 0 }} />
      </div>
      {/* Настройка прячет НАШУ кнопку — и только: у встроенного просмотрщика PDF есть
          своя кнопка сохранения, убрать её нельзя. Обещать больше значило бы обмануть
          владельца ссылки. */}
      {view.allowDownload && (
        <div style={{ marginTop: 'var(--spacing-4)', display: 'flex', gap: 'var(--spacing-3)' }}>
          <Button icon="download" href={view.pdf.url}>
            Скачать PDF
          </Button>
        </div>
      )}
    </>
  );
}
