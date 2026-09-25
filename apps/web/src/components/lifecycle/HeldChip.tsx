'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Chip, Tooltip } from '@/components/ui';
import { fetchHoldStatus } from '@/lib/lifecycle-api';
import { lifecycleHoldStatusKey } from '@/lib/queries';

/**
 * Чип «Заморожено до снятия» на карточке записи организации (сотрудник, документ). Факт видит
 * руководитель и выше — сервер остальным отвечает «нет», хранителю про себя тоже; платформенные
 * заморозки организация не видит вовсе. Слова — `common.heldChip.*`: чип живёт в карточках
 * разных сервисов, а словарь `lifecycle` целиком им не нужен.
 */
export function HeldChip({ workspaceId, type, id }: { workspaceId: string; type: 'user' | string; id: string }) {
  const t = useTranslations('common');
  const q = useQuery({ queryKey: lifecycleHoldStatusKey(workspaceId, type, id), queryFn: () => fetchHoldStatus(workspaceId, type, id), staleTime: 60_000 });
  if (!q.data?.held) return null;
  return (
    <Tooltip content={t('heldChip.hint')}>
      {/* Обёртка с фокусом: подсказка доступна и с клавиатуры */}
      <span tabIndex={0}>
        <Chip tone="neutral" icon="lock">{t('heldChip.label')}</Chip>
      </span>
    </Tooltip>
  );
}
