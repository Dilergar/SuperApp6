'use client';

/**
 * Мостик «шаг маршрута → подписание».
 *
 * Заявка на подпись заводится ЛЕНИВО: до того, как человек нажал «Подписать»,
 * замораживать документ незачем (его ещё десять раз перепишут). Поэтому здесь
 * сначала спрашиваем сервер «открой мне подписание этого шага», получаем заявку
 * и уже её отдаём в общее окно подписания.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, Modal, Spinner } from '@/components/ui';
import { LazyNamespace } from '@/i18n/LazyNamespace';
import { apiErrorMessage } from '@/lib/api';
import { openSignForStep } from './sign-api';
import { SignFlowModal } from './SignFlowModal';

/**
 * Словарь подписи доезжает ОТДЕЛЬНЫМ чанком: мостик открывается из стопки
 * «Ждут решения», которая живёт в каркасе, то есть на ЛЮБОЙ странице. Класть
 * каталог подписи в корневой провайдер значило бы возить его повсюду.
 */
export function SignStepModal(props: { stepId: string; onClose: () => void; onSigned?: () => void }) {
  return (
    <LazyNamespace ns="sign">
      <SignStepModalBody {...props} />
    </LazyNamespace>
  );
}

function SignStepModalBody({
  stepId,
  onClose,
  onSigned,
}: {
  stepId: string;
  onClose: () => void;
  onSigned?: () => void;
}) {
  const t = useTranslations('sign');
  // Ручка идемпотентна (партиальный уникум «одна живая заявка на шаг»), поэтому
  // повтор при рефетче безопасен — второй заявки не появится.
  const open = useQuery({
    queryKey: ['sign', 'for-step', stepId],
    queryFn: () => openSignForStep(stepId),
    retry: false,
    staleTime: Infinity,
  });

  if (open.isPending) {
    return (
      <Modal open onClose={onClose} title={t('flow.title')} size="sm">
        <div style={{ textAlign: 'center', padding: 'var(--spacing-5)' }}>
          <Spinner />
        </div>
      </Modal>
    );
  }

  if (open.isError || !open.data) {
    return (
      <Modal open onClose={onClose} title={t('flow.title')} size="sm">
        <Alert tone="danger">{apiErrorMessage(open.error)}</Alert>
      </Modal>
    );
  }

  return <SignFlowModal requestId={open.data.request.id} onClose={onClose} onSigned={onSigned} />;
}
