'use client';

// ============================================================
// Шлюз согласий (core/consents) — живёт в каркасе, поверх ЛЮБОЙ страницы (поэтому его слова
// в неймспейсе `shell`: до глобального слоя доезжают только `common` и `shell`).
//
//  - Дата вступления новой существенной версии прошла → БЛОКИРУЮЩИЙ ЭКРАН: «Что изменилось»
//    → полный текст → «Принимаю» / «Не принимаю, удалить аккаунт». Кнопки «вывести средства»
//    нет намеренно: платёжных рельсов не существует (UI несуществующих фич не показываем).
//  - Версия опубликована, но ещё не действует → БАННЕР «принять заранее».
//  - Условия для организаций: баннер владельцу и админам; работа сотрудников не останавливается.
//
// Источник правды — `GET /consents/pending`; сервер сообщает о шлюзе отказом `403 consents.pending`
// на любом запросе — перехватчик транспорта превращает его в событие, и экран появляется сразу.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { ConsentAcceptResultDto, ConsentPendingDto, ConsentPendingItemDto, Locale } from '@superapp/shared';
import { Alert, Button, Modal } from '@/components/ui';
import { analytics } from '@/lib/analytics';
import { apiGet, apiPost } from '@/lib/api';
import { CONSENTS_PENDING_EVENT } from '@/lib/consents-events';
import { useFormatters } from '@/lib/format';
import { consentsMineRootKey, consentsPendingKey } from '@/lib/queries';
import { useAuthStore } from '@/lib/stores/auth';

import { ConsentDocumentView } from './ConsentDocumentView';

import { toastApiError } from '@/lib/api-errors';
/** Страницы, которые шлюз не накрывает: вход, публичная витрина и мастер удаления аккаунта. */
const UNGATED = ['/login', '/register', '/reset-password', '/legal', '/account/delete', '/platform', '/s/', '/check'];

function useAccept(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { versionIds: string[]; locale: Locale; workspaceId?: string }) =>
      apiPost<ConsentAcceptResultDto>('/consents/accept', { ...input, channel: 'web' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: consentsMineRootKey });
      onDone?.();
    },
    onError: (err) => toastApiError(err),
  });
}

export function ConsentGate() {
  const pathname = usePathname() ?? '/';
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const skip = !user || UNGATED.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p.endsWith('/') ? p : `${p}/`));

  const pending = useQuery({
    queryKey: consentsPendingKey,
    queryFn: () => apiGet<ConsentPendingDto>('/consents/pending'),
    enabled: !skip,
    staleTime: 60_000,
    // Дата вступления наступает сама — без обновления вкладка узнала бы о шлюзе только от отказа сервера
    refetchInterval: 10 * 60_000,
  });

  // Сервер отказал `403 consents.pending` → перечитать немедленно (версия вступила в силу прямо сейчас)
  useEffect(() => {
    const onPending = () => void qc.invalidateQueries({ queryKey: consentsPendingKey });
    window.addEventListener(CONSENTS_PENDING_EVENT, onPending);
    return () => window.removeEventListener(CONSENTS_PENDING_EVENT, onPending);
  }, [qc]);

  if (skip || !pending.data) return null;
  if (pending.data.blocking.length > 0) return <BlockingScreen items={pending.data.blocking} />;
  return <ConsentBanner data={pending.data} />;
}

// ------------------------------------------------------------
// Блокирующий экран
// ------------------------------------------------------------

function BlockingScreen({ items }: { items: ConsentPendingItemDto[] }) {
  const t = useTranslations('shell');
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const uiLocale = useLocale() as Locale;
  const [index, setIndex] = useState(0);
  const [docLocale, setDocLocale] = useState<Locale>(uiLocale);
  const current = items[Math.min(index, items.length - 1)]!;
  const total = items.length;
  const accept = useAccept();

  useEffect(() => {
    analytics.track('consents.gate.shown', { documents: total });
    // Один раз на показ экрана: состав документов внутри показа не меняется
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Страница под экраном не прокручивается и не получает фокус
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onLocale = useCallback((l: Locale) => setDocLocale(l), []);
  const onAccept = () => {
    // Принимается ровно тот документ, что на экране, на том языке, на котором он показан
    accept.mutate({ versionIds: [current.versionId], locale: docLocale }, { onSuccess: () => setIndex(0) });
  };
  const onDecline = () => {
    analytics.track('consents.gate.declined', { documents: total });
    router.push('/account/delete');
  };

  return (
    <div className="consent-gate" role="dialog" aria-modal="true" aria-labelledby="consent-gate-title">
      <div className="consent-gate-card">
        <div>
          <h1 id="consent-gate-title" className="title-lg" style={{ margin: 0 }}>{t('consents.gate.title')}</h1>
          <p className="label-md" style={{ margin: 'var(--spacing-2) 0 0' }}>{t('consents.gate.subtitle')}</p>
          {total > 1 && <p className="label-sm" style={{ margin: 'var(--spacing-2) 0 0' }}>{t('consents.gate.progress', { current: 1, total })}</p>}
        </div>
        <ConsentDocumentView key={current.versionId} versionId={current.versionId} emphasizeChanges onLocaleChange={onLocale} />
        <div className="consent-gate-actions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
            <Button variant="ghost" tone="danger" onClick={onDecline}>{t('consents.gate.decline')}</Button>
            <Button variant="ghost" onClick={() => { void logout(); router.push('/login'); }}>{t('consents.gate.logout')}</Button>
          </div>
          <Button variant="primary" size="lg" loading={accept.isPending} onClick={onAccept}>{t('consents.gate.accept')}</Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Баннер «принять заранее» + условия для организаций
// ------------------------------------------------------------

/** ISO-даты сравниваются как строки: язык зрителя тут ни при чём. */
const byEffective = (a: ConsentPendingItemDto, b: ConsentPendingItemDto) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0);

type ReviewTarget = { items: ConsentPendingItemDto[]; workspaceId?: string; canAccept: boolean };

function ConsentBanner({ data }: { data: ConsentPendingDto }) {
  const t = useTranslations('shell');
  const fmt = useFormatters();
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const rows = useMemo(() => {
    const out: Array<{ id: string; tone: 'accent' | 'warning'; text: string; target: ReviewTarget }> = [];
    if (data.upcoming.length) {
      const first = [...data.upcoming].sort(byEffective)[0]!;
      out.push({ id: `me:${data.upcoming.map((d) => d.versionId).join(',')}`, tone: 'accent', text: t('consents.banner.text', { date: fmt.date(first.effectiveFrom) }), target: { items: data.upcoming, canAccept: true } });
    }
    for (const ws of data.workspaces) {
      if (ws.blocking.length) {
        out.push({ id: `wsb:${ws.workspaceId}`, tone: 'warning', text: t('consents.banner.workspaceBlocking', { name: ws.workspaceName }), target: { items: ws.blocking, workspaceId: ws.workspaceId, canAccept: ws.canAccept } });
      } else if (ws.upcoming.length) {
        const first = [...ws.upcoming].sort(byEffective)[0]!;
        out.push({ id: `wsu:${ws.workspaceId}`, tone: 'accent', text: t('consents.banner.workspaceUpcoming', { name: ws.workspaceName, date: fmt.date(first.effectiveFrom) }), target: { items: ws.upcoming, workspaceId: ws.workspaceId, canAccept: ws.canAccept } });
      }
    }
    return out.filter((r) => !hidden.has(r.id));
  }, [data, hidden, t, fmt]);

  if (!rows.length && !review) return null;
  return (
    <>
      {rows.length > 0 && (
        <div className="consent-banner-dock" role="region" aria-label={t('consents.review.title')}>
          {rows.map((r) => (
            <Alert
              key={r.id}
              tone={r.tone}
              icon="docs"
              onClose={() => setHidden((prev) => new Set(prev).add(r.id))}
              action={<Button size="sm" variant="matte" tone={r.tone} onClick={() => setReview(r.target)}>{t('consents.banner.action')}</Button>}
            >
              {r.text}
            </Alert>
          ))}
        </div>
      )}
      {review && <ReviewModal target={review} onClose={() => setReview(null)} />}
    </>
  );
}

function ReviewModal({ target, onClose }: { target: ReviewTarget; onClose: () => void }) {
  const t = useTranslations('shell');
  const uiLocale = useLocale() as Locale;
  const [index, setIndex] = useState(0);
  const [docLocale, setDocLocale] = useState<Locale>(uiLocale);
  const current = target.items[Math.min(index, target.items.length - 1)]!;
  const last = index >= target.items.length - 1;
  const accept = useAccept();
  const onLocale = useCallback((l: Locale) => setDocLocale(l), []);

  const onAccept = () => {
    accept.mutate(
      { versionIds: [current.versionId], locale: docLocale, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) },
      { onSuccess: () => (last ? onClose() : setIndex((i) => i + 1)) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={t('consents.review.title')}
      subtitle={target.items.length > 1 ? t('consents.gate.progress', { current: index + 1, total: target.items.length }) : undefined}
      footer={
        target.canAccept ? (
          <Button variant="primary" loading={accept.isPending} onClick={onAccept}>{t('consents.gate.accept')}</Button>
        ) : (
          <span className="label-sm">{t('consents.banner.ownerOnly')}</span>
        )
      }
    >
      <ConsentDocumentView key={current.versionId} versionId={current.versionId} emphasizeChanges onLocaleChange={onLocale} />
    </Modal>
  );
}
