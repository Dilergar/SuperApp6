'use client';

// ============================================================
// Категории: дерево расходов/доходов до 2 уровней — раздел «Категории».
// Вынесено из page.tsx при переходе на сайдбар-разделы.
// ============================================================

import { useState } from 'react';
import type { FinAccountDto } from '@superapp/shared';
import { api, apiErrorMessage } from '@/lib/api';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmptyState,
  IconButton, Input, Modal, SegmentedControl, Select,
} from '@/components/ui';
import { bookParams } from './finance-lib';
import { FinGlyph } from './finance-ui';

export function CategoriesPanel({
  categories,
  onChanged,
  bookId,
  canEdit,
}: {
  categories: FinAccountDto[];
  onChanged: () => void;
  bookId: string | null;
  canEdit: boolean;
}) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FinAccountDto | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = categories.filter((c) => c.kind === kind && !c.archived);
  const roots = visible.filter((c) => !c.parentId);
  const childrenOf = (id: string) => visible.filter((c) => c.parentId === id);

  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await api.delete(`/finance/categories/${removing.id}`, bookParams(bookId));
      setRemoving(null);
      onChanged();
    } catch (e) {
      window.alert(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BentoGrid>
        <Card span={12}>
          <CardHeader
            title="Категории"
            subtitle="На что уходит и откуда приходит. Второй уровень — подкатегории"
            actions={
              <>
                <SegmentedControl
                  aria-label="Вид категорий"
                  value={kind}
                  onChange={(k) => setKind(k)}
                  items={[
                    { key: 'expense', label: 'Расходы', icon: 'trendDown' },
                    { key: 'income', label: 'Доходы', icon: 'trendUp' },
                  ]}
                />
                {canEdit && (
                  <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setAdding(true)}>
                    Категория
                  </Button>
                )}
              </>
            }
          />

          {roots.length > 0 ? (
            <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
              {roots.map((root) => {
                const kids = childrenOf(root.id);
                return (
                  <div key={root.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                      {/* Эмодзи категории — данные человека; иначе интерфейсный фолбэк */}
                      <FinGlyph glyph={root.icon} size={30} fallback={kind === 'expense' ? 'receipt' : 'coins'} tone={kind === 'expense' ? 'neutral' : 'success'} />
                      <span className="title-sm" style={{ flex: 1, minWidth: 0 }}>{root.name}</span>
                      {canEdit && (
                        <IconButton icon="delete" label={`Удалить «${root.name}»`} size={30} onClick={() => setRemoving(root)} />
                      )}
                    </div>
                    {kids.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', margin: '0.5rem 0 0 2.375rem' }}>
                        {kids.map((child) => (
                          <Chip
                            key={child.id}
                            size="sm"
                            emoji={child.icon}
                            onRemove={canEdit ? () => setRemoving(child) : undefined}
                            removeLabel={`Удалить «${child.name}»`}
                          >
                            {child.name}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={kind === 'expense' ? 'receipt' : 'coins'}
              title={kind === 'expense' ? 'Категорий расходов нет' : 'Категорий доходов нет'}
              description="Базовое дерево создаётся вместе с книгой — добавьте свои по ходу."
              action={canEdit ? <Button variant="primary" tone="success" icon="add" onClick={() => setAdding(true)}>Добавить категорию</Button> : undefined}
            />
          )}
        </Card>
      </BentoGrid>

      {adding && canEdit && (
        <NewCategoryModal
          kind={kind}
          roots={roots}
          bookId={bookId}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); onChanged(); }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Удалить «${removing.name}»?` : 'Удалить категорию?'}
        message="Если по категории есть операции — она уйдёт в архив, история сохранится."
        confirmLabel="Удалить"
        danger
        loading={busy}
      />
    </>
  );
}

function NewCategoryModal({
  kind,
  roots,
  bookId,
  onClose,
  onDone,
}: {
  kind: 'expense' | 'income';
  roots: FinAccountDto[];
  bookId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) { setError('Укажите название'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post('/finance/categories', {
        kind,
        name: name.trim(),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(parentId ? { parentId } : {}),
      }, bookParams(bookId));
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'expense' ? 'Новая категория расходов' : 'Новая категория доходов'}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" onClick={submit} loading={busy}>Создать</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 5rem', gap: 'var(--spacing-3)' }}>
          <Input label="Название" placeholder="Продукты" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Input label="Значок" placeholder="🙂" value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={4} />
        </div>
        <Select
          label="Родитель"
          value={parentId}
          onChange={setParentId}
          options={[
            { value: '', label: 'Без родителя (корневая)' },
            ...roots.map((r) => ({ value: r.id, label: `Внутри «${r.name}»`, emoji: r.icon })),
          ]}
        />
      </div>
    </Modal>
  );
}
