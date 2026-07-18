'use client';

import dynamic from 'next/dynamic';

// livekit-client живёт только в браузере (WebRTC) — комната монтируется без SSR.
const MeetingRoom = dynamic(() => import('./MeetingRoom'), {
  ssr: false,
  loading: () => <p className="label-md">Загрузка встречи…</p>,
});

export default function MeetingRoomPage() {
  return <MeetingRoom />;
}
