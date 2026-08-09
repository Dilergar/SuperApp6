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
import { Alert, Modal, Spinner } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { openSignForStep } from './sign-api';
import { SignFlowModal } from './SignFlowModal';

export function SignStepModal({
  stepId,
  onClose,
  onSigned,
}: {
  stepId: string;
  onClose: () => void;
  onSigned?: () => void;
}) {
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
      <Modal open onClose={onClose} title="Подписание документа" size="sm">
        <div style={{ textAlign: 'center', padding: 'var(--spacing-5)' }}>
          <Spinner />
        </div>
      </Modal>
    );
  }

  if (open.isError || !open.data) {
    return (
      <Modal open onClose={onClose} title="Подписание документа" size="sm">
        <Alert tone="danger">{apiErrorMessage(open.error)}</Alert>
      </Modal>
    );
  }

  return <SignFlowModal requestId={open.data.request.id} onClose={onClose} onSigned={onSigned} />;
}
