'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

// Заглушка загрузки — отдельный компонент: `loading` вычисляется вне рендера
// страницы, а хук каталога живёт только внутри компонента.
function RoomLoading() {
  const t = useTranslations('office');
  return <p className="label-md">{t('room.loading')}</p>;
}

// livekit-client живёт только в браузере (WebRTC) — комната монтируется без SSR.
const MeetingRoom = dynamic(() => import('./MeetingRoom'), {
  ssr: false,
  loading: () => <RoomLoading />,
});

export default function MeetingRoomPage() {
  return <MeetingRoom />;
}
