'use client';

// ============================================================
// Переключатель языка — ОДИН тумблер на весь продукт.
//
// Что происходит по выбору:
//  1. cookie `sa6_locale` — её читает и сервер (первый кадр RSC), и транспорт
//     (`Accept-Language` на каждый запрос к API);
//  2. `PATCH /users/me { locale }` для авторизованного — язык переезжает на
//     другие устройства и на фоновые тексты (push/SMS в `User.locale`);
//  3. `router.refresh()` — сервер пересобирает дерево на новом языке БЕЗ
//     перезагрузки страницы;
//  4. сброс кэша React Query — тексты уведомлений и хроники приходят от API
//     готовыми (рендер при чтении), поэтому старые ответы обязаны протухнуть.
//
// Гость проходит те же шаги, кроме второго: аккаунта нет, помнить некому.
// ============================================================
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALE_DISPLAY_ORDER, LOCALE_NAMES, type Locale } from '@superapp/shared';
import { Select } from '@/components/ui/Select';
import { apiPatch } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { useAuthStore } from '@/lib/stores/auth';
import { writeLocaleCookie } from '@/i18n/locale';

/**
 * Автонимы — единственные строки продукта, которые НЕ переводятся.
 * Порядок — продуктовый (`LOCALE_DISPLAY_ORDER`), а не алфавитный: сортировка по
 * автониму ставила русский выше английского.
 */
const OPTIONS = LOCALE_DISPLAY_ORDER.map((value) => ({ value, label: LOCALE_NAMES[value] }));

export function LanguageSwitcher({
  label,
  width = 200,
  compact,
}: {
  /** Подпись поля; не задана — берётся из каталога. */
  label?: string;
  width?: number | string;
  /**
   * Шапка страницы: без подписи и подсказки — там на них нет места, а смысл
   * несёт сам список автонимов («Қазақша», «Русский», «English»).
   */
  compact?: boolean;
}) {
  // Неймспейс `common`, а не `profile`: переключатель стоит и на ГОСТЕВЫХ
  // экранах (вход, регистрация, /s/<токен>), где каталога профиля нет и быть
  // не должно — иначе экран входа тащил бы словарь настроек.
  const t = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  const change = async (next: Locale) => {
    if (next === locale) return;
    setBusy(true);
    // Cookie ставим ПЕРВОЙ: она источник и для сервера, и для заголовка запроса.
    // Если следом упадёт PATCH, человек всё равно уже видит выбранный язык.
    writeLocaleCookie(next);
    try {
      if (isAuthenticated) {
        await apiPatch('/users/me', { locale: next });
        if (user) useAuthStore.setState({ user: { ...user, locale: next } });
      }
      // Тексты, собранные сервером (уведомления, хроника, плашки), лежат в кэше
      // на старом языке — они не «устарели по данным», но устарели по языку.
      await queryClient.invalidateQueries();
      startTransition(() => router.refresh());
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Select<Locale>
      value={locale}
      onChange={(v) => void change(v)}
      options={OPTIONS}
      label={compact ? undefined : label ?? t('language.label')}
      hint={compact ? undefined : t('language.hint')}
      disabled={busy || pending}
      width={width}
      aria-label={t('language.label')}
    />
  );
}
