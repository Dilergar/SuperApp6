'use client';

// ============================================================
// useConfirm — подтверждение опасного действия через ConfirmDialog кита.
//
// Почему не нативный confirm(): браузер позволяет человеку поставить галочку
// «Блокировать создание диалогов», и после неё confirm() МОЛЧА возвращает false.
// Кнопки «Удалить», «Покинуть группу», «Завершить звонок» просто перестают
// работать, и понять почему — невозможно. Плюс нативное окно рисуется средствами
// ОС, то есть выпадает из дизайн-системы на самом ответственном экране.
//
// Локальный хук, а не глобальный провайдер: ConfirmDialog тянет за собой Modal,
// и провайдер в корне утащил бы его в граф КАЖДОЙ страницы. Здесь окно грузится
// только там, где реально есть опасное действие.
//
// Использование:
//   const [confirm, confirmUI] = useConfirm();
//   <Button onClick={() => confirm({ title: 'Удалить задачу?', danger: true }, remove)} />
//   {confirmUI}
// ============================================================
import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './Modal';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Необратимое действие — кнопка подтверждения красная. */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  onConfirm: () => void | Promise<void>;
}

export function useConfirm(): [(options: ConfirmOptions, onConfirm: () => void | Promise<void>) => void, ReactNode] {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = useCallback((options: ConfirmOptions, onConfirm: () => void | Promise<void>) => {
    setState({ ...options, onConfirm });
  }, []);

  const close = useCallback(() => {
    setState(null);
    setBusy(false);
  }, []);

  const run = useCallback(async () => {
    if (!state) return;
    try {
      setBusy(true);
      // Действие может быть асинхронным (запрос к API) — держим окно с индикатором,
      // пока не завершится, иначе человек успевает нажать второй раз.
      await state.onConfirm();
      close();
    } catch {
      // Сообщение об ошибке показывает сам вызывающий код (toast) — окно просто
      // закрываем, чтобы оно не висело поверх сообщения.
      close();
    }
  }, [state, close]);

  const ui = state ? (
    <ConfirmDialog
      open
      onClose={close}
      onConfirm={run}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      loading={busy}
    />
  ) : null;

  return [confirm, ui];
}
