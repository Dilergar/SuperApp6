'use client';

// ============================================================
// «Ссылки наружу» — единственное место, где видно ВСЁ, что человек раздал за пределы
// платформы: и с Диска, и из документов, а завтра из счетов и витрин.
//
// Почему в профиле, а не внутри Диска: ссылки выдают разные сервисы, и внутри одного
// из них список был бы неполным — то есть врал бы ровно в тот момент, когда в него
// приходят разбираться, откуда файл ушёл наружу.
//
// Сам список — общий обозреватель `ShareLinksBrowser` (тот же, что у организации):
// различаются только скоуп и загрузчики.
// ============================================================

import { useTranslations } from 'next-intl';
import { ShareLinksBrowser } from '@/components/share-links/ShareLinksBrowser';
import { myShareLinksScopeKey } from '@/lib/queries';
import { fetchMyShareLinks, fetchMyShareStats, revokeMyShareLinks } from '@/lib/share-links-api';

export default function ProfileLinksPage() {
  const t = useTranslations('share');
  return (
    <ShareLinksBrowser
      title={t('mine.title')}
      subtitle={t('mine.subtitle')}
      emptyDescription={t('mine.empty')}
      source={{
        keyPrefix: myShareLinksScopeKey,
        list: ({ status, cursor }) => fetchMyShareLinks({ status, ...(cursor ? { cursor } : {}) }),
        stats: fetchMyShareStats,
        revoke: revokeMyShareLinks,
      }}
    />
  );
}
