import type { NextConfig } from 'next';

// Адрес API известен на сборке; из него выводим http(s)- и ws(s)-источники для CSP.
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const apiOrigin = (() => {
  try {
    return new URL(API_URL).origin;
  } catch {
    return 'http://localhost:3001';
  }
})();
const apiWsOrigin = apiOrigin.replace(/^http/, 'ws');

// Адрес LiveKit приходит от API в РАНТАЙМЕ (calls.service отдаёт wsUrl), поэтому на
// сборке его нет. Пока даём широкое ws:/wss: в connect-src; сузить можно, заведя
// NEXT_PUBLIC_LIVEKIT_WS_URL и подставив его сюда.
const LIVEKIT_WS = process.env.NEXT_PUBLIC_LIVEKIT_WS_URL || 'ws: wss:';

// Полный CSP пока в режиме ОТЧЁТА: приложение живое (LiveKit, socket.io, xyflow,
// Lottie, blob-медиа), и включать его enforcing без прогона всех экранов — верный
// способ молча сломать звонок или канвас. Тюним по отчётам, потом переносим в
// Content-Security-Policy.
const cspReportOnly = [
  "default-src 'self'",
  // Next держит инлайновый бутстрап; в dev нужен ещё eval (React Refresh).
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'", // Tailwind + инлайновые стили xyflow
  `img-src 'self' data: blob: ${apiOrigin}`,
  `media-src 'self' blob: ${apiOrigin}`, // записи, голосовые, видео-вложения
  `connect-src 'self' ${apiOrigin} ${apiWsOrigin} ${LIVEKIT_WS}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:", // LiveKit
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  transpilePackages: ['@superapp/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Кликджекинг: приложение — кликабельный SPA за долгой сессией, и у него есть
          // одно-кликовые действия, двигающие деньги (приёмка задачи, подтверждение
          // заказа). Запрет фрейминга ничего не ломает — включаем сразу, в двух формах
          // ради старых браузеров.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Content-Security-Policy-Report-Only', value: cspReportOnly },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Микрофон и камера нужны звонкам и диктофону — оставляем self.
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), payment=(), usb=(), microphone=(self), camera=(self), display-capture=(self)',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
