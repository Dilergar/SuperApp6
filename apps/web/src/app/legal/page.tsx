import { redirect } from 'next/navigation';

// Корень витрины — Пользовательское соглашение: остальные документы в её навигации
export default function LegalIndexPage() {
  redirect('/legal/terms');
}
