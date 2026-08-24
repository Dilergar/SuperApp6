'use client';

// ============================================================
// Библиотека кадровых бланков РК (КЭДО, Этап 3): каталог живёт в коде платформы,
// «Установить» = мастер — спрашивает подписанта организации ОДИН раз и публикует
// вид + шаблон + маршрут сразу (черновик-маршрут = действие, которое никогда
// не применится).
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HrLibraryItemDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { fetchHrLibrary, installHrLibraryItem } from '@/lib/hr-api';
import { docTemplatesKey, docTypesKey, hrLibraryKey } from '@/lib/queries';
import { toast, toastError } from '@/lib/toast';
import { Alert, Button, Card, CardHeader, Chip, LoadingBlock, Modal, SegmentedControl } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';

export function HrLibraryBlock({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [installing, setInstalling] = useState<HrLibraryItemDto | null>(null);
  const [open, setOpen] = useState(false);

  const libraryQ = useQuery({
    queryKey: hrLibraryKey(workspaceId),
    queryFn: () => fetchHrLibrary(workspaceId),
  });

  const items = libraryQ.data ?? [];
  const installed = items.filter((i) => i.installed).length;

  return (
    <Card span={12}>
      <CardHeader
        title="Библиотека кадровых бланков РК"
        subtitle="Трудовой договор, приказы, заявления, согласие на ПД, уведомления — с готовыми маршрутами и зашитым уровнем подписи (ст. 33 ТК РК: кадровые — ЭЦП)"
        actions={
          <Button variant="matte" size="sm" icon={open ? 'caretUp' : 'caretDown'} onClick={() => setOpen((v) => !v)}>
            {open ? 'Свернуть' : `Открыть (установлено ${installed} из ${items.length})`}
          </Button>
        }
      />
      {open &&
        (libraryQ.isPending ? (
          <LoadingBlock />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 'var(--spacing-3)' }}>
            {items.map((item) => (
              <div
                key={item.key}
                style={{
                  border: '1px solid var(--card-border)',
                  borderRadius: 14,
                  padding: 'var(--spacing-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--spacing-2)',
                }}
              >
                <div style={{ fontWeight: 700 }}>{item.title}</div>
                <div className="meta" style={{ flex: 1 }}>{item.description}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip tone={item.signatureLevel === 'ecp' ? 'accent' : item.signatureLevel === 'pep' ? 'neutral' : 'neutral'}>
                    {item.signatureLevel === 'ecp' ? 'ЭЦП' : item.signatureLevel === 'pep' ? 'ПЭП (SMS)' : 'Без подписи'}
                  </Chip>
                  {item.installed ? (
                    item.updateAvailable ? (
                      <Button variant="matte" size="sm" icon="refresh" onClick={() => setInstalling(item)}>
                        Обновить
                      </Button>
                    ) : (
                      <Chip tone="success" icon="check">Установлен</Chip>
                    )
                  ) : (
                    <Button variant="primary" size="sm" icon="download" onClick={() => setInstalling(item)}>
                      Установить
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

      {installing && (
        <InstallWizard
          workspaceId={workspaceId}
          item={installing}
          onClose={() => setInstalling(null)}
          onDone={() => {
            setInstalling(null);
            void qc.invalidateQueries({ queryKey: hrLibraryKey(workspaceId) });
            // Ключи — из lib/queries (правило платформы): литерал рядом с общим
            // ключом разъезжается молча, и список шаблонов после установки
            // остаётся прежним до перезагрузки.
            void qc.invalidateQueries({ queryKey: docTemplatesKey(workspaceId) });
            void qc.invalidateQueries({ queryKey: docTypesKey(workspaceId) });
          }}
        />
      )}
    </Card>
  );
}

function InstallWizard({
  workspaceId,
  item,
  onClose,
  onDone,
}: {
  workspaceId: string;
  item: HrLibraryItemDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const [signerMode, setSignerMode] = useState<'position' | 'user'>('position');
  const [signer, setSigner] = useState<Principal[]>([]);

  const install = useMutation({
    mutationFn: () => {
      if (!signer[0]) throw new Error('Укажите подписанта организации');
      return installHrLibraryItem(workspaceId, {
        key: item.key,
        ...(signerMode === 'user' ? { signerUserId: signer[0].id } : { signerPositionId: signer[0].id }),
      });
    },
    onSuccess: () => {
      toast(`«${item.title}» установлен: вид, шаблон и маршрут опубликованы`, 'success');
      onDone();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Установить: ${item.title}`} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Alert tone="accent">
          Мастер создаст вид документа, опубликованный шаблон-конструктор и ОПУБЛИКОВАННЫЙ маршрут. Подписант
          спрашивается один раз и проставляется в шаг «Подписать».
        </Alert>
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>Кто подписывает от организации</div>
          <SegmentedControl
            aria-label="Вид подписанта"
            value={signerMode}
            onChange={(v) => {
              setSignerMode(v);
              setSigner([]);
            }}
            items={[
              { key: 'position', label: 'Должность (кто на ней сейчас)' },
              { key: 'user', label: 'Конкретный человек' },
            ]}
          />
        </div>
        <EntitySelector
          types={[signerMode]}
          multi={false}
          value={signer}
          onChange={setSigner}
          context={{ workspaceId }}
          placeholder={signerMode === 'position' ? 'Например, Директор' : 'Выберите сотрудника'}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" loading={install.isPending} onClick={() => install.mutate()}>
            Установить и опубликовать
          </Button>
        </div>
      </div>
    </Modal>
  );
}
