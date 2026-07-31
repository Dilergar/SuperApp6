'use client';

// ============================================================
// Категории: дерево расходов/доходов до 2 уровней — раздел «Категории».
//
// Каждая корневая категория — СВОЯ карточка бенто-сетки: значок, название и
// действия (правка, удаление) стоят рядом, а не в разных концах широкой строки.
// Подкатегории живут чипами внутри своей карточки, и там же — «+ Подкатегория»:
// добавление не уводит в общий диалог, где родителя пришлось бы выбирать заново.
// ============================================================

import { useMemo, useState } from 'react';
import type { FinAccountDto } from '@superapp/shared';
import { api, apiErrorMessage } from '@/lib/api';
import {
  Alert, BentoGrid, Button, Card, Chip, ConfirmDialog, EmptyState, GlyphField,
  IconButton, Input, Modal, SegmentedControl, Select, type IconName, type Tone,
} from '@/components/ui';
import { bookParams } from './finance-lib';
import { FinGlyph } from './finance-ui';
import { toastError } from '@/lib/toast';

type Kind = 'expense' | 'income';

/** Что открыто в диалоге: создание (родитель уже известен) или правка. */
type Editor =
  | { mode: 'create'; parentId: string | null }
  | { mode: 'edit'; category: FinAccountDto; hasChildren: boolean };


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
  const [kind, setKind] = useState<Kind>('expense');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState<FinAccountDto | null>(null);
  const [busy, setBusy] = useState(false);

  const { roots, childrenOf } = useMemo(() => {
    const visible = categories.filter((c) => c.kind === kind && !c.archived);
    const byParent = new Map<string, FinAccountDto[]>();
    for (const c of visible) {
      if (!c.parentId) continue;
      const list = byParent.get(c.parentId);
      if (list) list.push(c);
      else byParent.set(c.parentId, [c]);
    }
    return { roots: visible.filter((c) => !c.parentId), childrenOf: byParent };
  }, [categories, kind]);

  const glyphTone: Tone = kind === 'expense' ? 'neutral' : 'success';
  const fallbackIcon: IconName = kind === 'expense' ? 'receipt' : 'coins';

  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await api.delete(`/finance/categories/${removing.id}`, bookParams(bookId));
      setRemoving(null);
      onChanged();
    } catch (e) {
      toastError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Панель раздела: вид дерева слева, создание — справа */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '0.75rem', flexWrap: 'wrap', marginBottom: 'var(--gap-grid)',
        }}
      >
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
          <Button
            variant="primary"
            tone="success"
            size="sm"
            icon="add"
            onClick={() => setEditor({ mode: 'create', parentId: null })}
          >
            Категория
          </Button>
        )}
      </div>

      {roots.length > 0 ? (
        <BentoGrid>
          {roots.map((root) => {
            const kids = childrenOf.get(root.id) ?? [];
            return (
              <Card key={root.id} small span={4}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  {/* Эмодзи категории — данные человека; иначе интерфейсный фолбэк */}
                  <FinGlyph glyph={root.icon} size={34} fallback={fallbackIcon} tone={glyphTone} />
                  <span
                    className="title-sm"
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={root.name}
                  >
                    {root.name}
                  </span>
                  {canEdit && (
                    <span style={{ display: 'flex', gap: '0.125rem', flex: 'none' }}>
                      <IconButton
                        icon="edit"
                        label={`Изменить «${root.name}»`}
                        size={30}
                        onClick={() => setEditor({ mode: 'edit', category: root, hasChildren: kids.length > 0 })}
                      />
                      {/* Удаление корневой с детьми сервер отклоняет — не даём кликнуть в тупик */}
                      <IconButton
                        icon="delete"
                        variant="danger"
                        size={30}
                        disabled={kids.length > 0}
                        label={
                          kids.length > 0
                            ? `Сначала удалите подкатегории «${root.name}»`
                            : `Удалить «${root.name}»`
                        }
                        onClick={() => setRemoving(root)}
                      />
                    </span>
                  )}
                </div>

                {(kids.length > 0 || canEdit) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: 'var(--spacing-3)' }}>
                    {kids.map((child) => (
                      <Chip
                        key={child.id}
                        size="sm"
                        emoji={child.icon}
                        title={canEdit ? `Изменить «${child.name}»` : undefined}
                        onClick={canEdit ? () => setEditor({ mode: 'edit', category: child, hasChildren: false }) : undefined}
                        onRemove={canEdit ? () => setRemoving(child) : undefined}
                        removeLabel={`Удалить «${child.name}»`}
                      >
                        {child.name}
                      </Chip>
                    ))}
                    {canEdit && (
                      <Chip
                        size="sm"
                        tone="accent"
                        icon="add"
                        title={`Добавить подкатегорию в «${root.name}»`}
                        onClick={() => setEditor({ mode: 'create', parentId: root.id })}
                      >
                        Подкатегория
                      </Chip>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </BentoGrid>
      ) : (
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon={fallbackIcon}
              title={kind === 'expense' ? 'Категорий расходов нет' : 'Категорий доходов нет'}
              description="Базовое дерево создаётся вместе с книгой — добавьте свои по ходу."
              action={
                canEdit ? (
                  <Button variant="primary" tone="success" icon="add" onClick={() => setEditor({ mode: 'create', parentId: null })}>
                    Добавить категорию
                  </Button>
                ) : undefined
              }
            />
          </Card>
        </BentoGrid>
      )}

      {editor && canEdit && (
        <CategoryModal
          // key: диалог переоткрывается на другую категорию — поля должны
          // перечитать её значения, а не остаться от прошлой
          key={editor.mode === 'edit' ? editor.category.id : `new:${editor.parentId ?? 'root'}`}
          kind={kind}
          roots={roots}
          editor={editor}
          bookId={bookId}
          onClose={() => setEditor(null)}
          onDone={() => { setEditor(null); onChanged(); }}
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

/** Один диалог на создание и правку: поля те же, отличается только отправка. */
function CategoryModal({
  kind,
  roots,
  editor,
  bookId,
  onClose,
  onDone,
}: {
  kind: Kind;
  roots: FinAccountDto[];
  editor: Editor;
  bookId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const editing = editor.mode === 'edit' ? editor.category : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [icon, setIcon] = useState(editing?.icon ?? '');
  const [parentId, setParentId] = useState(
    editor.mode === 'create' ? (editor.parentId ?? '') : (editing?.parentId ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Родителя нельзя менять у категории с подкатегориями: дерево ровно на два
  // уровня, сервер такой перенос отклоняет (409) — показываем это заранее.
  const lockedParent = editor.mode === 'edit' && editor.hasChildren;
  const parentName = parentId ? roots.find((r) => r.id === parentId)?.name : null;

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) { setError('Укажите название'); return; }
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const patch: Record<string, unknown> = {};
        if (trimmed !== editing.name) patch.name = trimmed;
        const nextIcon = icon.trim();
        if (nextIcon !== (editing.icon ?? '')) patch.icon = nextIcon || null;
        if (!lockedParent) {
          const nextParent = parentId || null;
          if (nextParent !== (editing.parentId ?? null)) patch.parentId = nextParent;
        }
        // Пустой patch схема отклоняет («Нечего обновлять») — просто закрываем
        if (Object.keys(patch).length === 0) { onClose(); return; }
        await api.patch(`/finance/categories/${editing.id}`, patch, bookParams(bookId));
      } else {
        await api.post('/finance/categories', {
          kind,
          name: trimmed,
          ...(icon.trim() ? { icon: icon.trim() } : {}),
          ...(parentId ? { parentId } : {}),
        }, bookParams(bookId));
      }
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = editing
    ? `Изменить «${editing.name}»`
    : parentName
      ? 'Новая подкатегория'
      : kind === 'expense' ? 'Новая категория расходов' : 'Новая категория доходов';

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      subtitle={!editing && parentName ? `Внутри «${parentName}»` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            tone="success"
            icon={editing ? 'save' : 'add'}
            onClick={submit}
            loading={busy}
          >
            {editing ? 'Сохранить' : 'Создать'}
          </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 'var(--spacing-3)', alignItems: 'start' }}>
          <Input label="Название" placeholder="Продукты" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {/* Подсказка выборщику — уже введённое название: «Питомцы» сразу
              показывает животных, искать заново не приходится. */}
          <GlyphField value={icon} onChange={(v) => setIcon(v ?? '')} suggest={name} />
        </div>
        <Select
          label="Родитель"
          value={lockedParent ? '' : parentId}
          onChange={setParentId}
          disabled={lockedParent}
          hint={lockedParent ? 'У категории есть подкатегории — перенести её нельзя' : undefined}
          options={[
            { value: '', label: 'Без родителя (корневая)', icon: 'folder' },
            ...roots
              .filter((r) => r.id !== editing?.id)
              .map((r) => ({ value: r.id, label: `Внутри «${r.name}»`, emoji: r.icon })),
          ]}
        />
      </div>
    </Modal>
  );
}
