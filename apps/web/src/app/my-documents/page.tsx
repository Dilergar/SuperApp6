'use client';

// ============================================================
// «Мои документы» (КЭДО, Этап 9) — ЛИЧНЫЙ архив: всё, что человек подписал,
// с чем ознакомился и что ему вручили работодатели. Доступ БЕССРОЧНЫЙ:
// записи переживают увольнение И закрытие компании (PersonalDocRecord +
// FileLink personal_doc держат файл живым после purge организации).
//
// Инвариант «контекст из пути» не нарушается: страница читает СВОИ записи,
// в живые организации ведут ссылки (паттерн MyApprovalsList).
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERSONAL_DOC_KINDS, type PersonalDocKind } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { fetchMyHrDocuments } from '@/lib/hr-api';
import { myHrDocumentsKey } from '@/lib/queries';
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  LoadingBlock,
  PageHeader,
  SegmentedControl,
  type TabItem,
} from '@/components/ui';

const KIND_LABEL: Record<PersonalDocKind, string> = PERSONAL_DOC_KINDS.reduce(
  (acc, k) => ({ ...acc, [k.value]: k.label }),
  {} as Record<PersonalDocKind, string>,
);

type Filter = 'all' | PersonalDocKind;

export default function MyDocumentsPage() {
  const { isReady } = useRequireAuth();
  const [filter, setFilter] = useState<Filter>('all');

  const docsQ = useQuery({
    queryKey: myHrDocumentsKey,
    queryFn: fetchMyHrDocuments,
    enabled: isReady,
  });

  if (!isReady || docsQ.isPending) return <LoadingBlock />;

  const items = (docsQ.data?.items ?? []).filter((r) => filter === 'all' || r.kind === filter);
  const tabs: TabItem<Filter>[] = [
    { key: 'all', label: 'Все', count: docsQ.data?.items.length ?? 0 },
    ...PERSONAL_DOC_KINDS.map((k) => ({ key: k.value as Filter, label: k.label })),
  ];

  return (
    <>
      <PageHeader
        title="Мои документы"
        description="Личный архив кадровых документов: доступ бессрочный — переживает увольнение и закрытие компании"
      />

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label="Фильтр архива" items={tabs} value={filter} onChange={setFilter} />
      </div>

      {docsQ.isError ? (
        <EmptyState
          icon="warningCircle"
          title="Архив не загрузился"
          action={<Button variant="matte" icon="refresh" onClick={() => docsQ.refetch()}>Повторить</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="folder"
          title="Пока пусто"
          description="Здесь появится всё, что вы подпишете, с чем ознакомитесь и что вам вручат работодатели — навсегда."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          {items.map((r) => (
            <Card key={r.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, wordBreak: 'break-word' }}>
                    {r.number ? `${r.title} № ${r.number}` : r.title}
                  </div>
                  <div className="meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                    <span>{r.workspaceName}</span>
                    {!r.workspaceAlive && <Chip tone="neutral">организация закрыта — файл сохранён</Chip>}
                    {r.docTypeName && <span>· {r.docTypeName}</span>}
                    <span>· {new Date(r.reachedAt).toLocaleDateString('ru-RU')}</span>
                  </div>
                </div>
                <Chip tone={r.kind === 'signed' ? 'accent' : r.kind === 'acknowledged' ? 'neutral' : 'success'}>
                  {KIND_LABEL[r.kind]}
                </Chip>
                {r.downloadUrl && (
                  <Button variant="matte" size="sm" icon="download" href={r.downloadUrl}>
                    Скачать
                  </Button>
                )}
                {r.checkUrl && (
                  <Button variant="ghost" size="sm" icon="signature" href={r.checkUrl}>
                    Проверка подписи
                  </Button>
                )}
                {r.workspaceAlive && r.orgDocumentId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="arrowRight"
                    href={`/workspaces/${r.workspaceId}/documents/${r.orgDocumentId}`}
                  >
                    Открыть в организации
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {(docsQ.data?.items.length ?? 0) >= 200 && (
        <div style={{ marginTop: 'var(--spacing-3)' }} className="meta">
          Показаны последние 200 записей архива — более ранние доступны по запросу в организации.
        </div>
      )}

      <div style={{ marginTop: 'var(--gap-grid)' }}>
        {/* Экран-подсказка «нет ЭЦП» (Этап 9): получить ключ можно удалённо */}
        <Alert tone="accent" title="Нет ЭЦП?">
          Ключ НУЦ РК выдаётся удалённо: egov.kz → «Получить ЭЦП» (видеоверификация) — или в приложении eGov Mobile
          (раздел «Цифровые документы → ЭЦП»). Подписывать документы можно с телефона по QR-коду через eGov Mobile —
          отдельный ключ на компьютере не обязателен.
        </Alert>
      </div>
    </>
  );
}
