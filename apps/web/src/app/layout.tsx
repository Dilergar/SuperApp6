import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'SuperApp6 — Одно приложение для всего',
  description: 'SuperApp6 объединяет задачи, календарь, финансы и рабочие инструменты в одном аккаунте',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
