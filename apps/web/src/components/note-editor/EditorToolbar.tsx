'use client';

import { useState } from 'react';
import type { Command } from 'prosemirror-state';
import { normalizeNoteHref } from '@superapp/shared';
import { Button, IconButton, Input, Menu, usePopover, type IconName } from '@/components/ui';
import { cmd, type BlockKind, type EditorSnapshot, type ListKind } from './plugins';

// ============================================================
// Панель форматирования редактора заметок — из кнопок кита. Активное состояние —
// aria-pressed (смысл несёт форма, не самодельный цвет).
// ============================================================

interface Props {
  snap: EditorSnapshot | null;
  compact: boolean;
  onCommand: (command: Command) => void;
  onImage: () => void;
  canUpload: boolean;
  extra?: React.ReactNode;
}

const BLOCKS: Array<{ kind: BlockKind; icon: IconName; label: string }> = [
  { kind: 'heading1', icon: 'headingOne', label: 'Заголовок 1' },
  { kind: 'heading2', icon: 'headingTwo', label: 'Заголовок 2' },
  { kind: 'heading3', icon: 'headingThree', label: 'Заголовок 3' },
];

const LISTS: Array<{ kind: ListKind; icon: IconName; label: string }> = [
  { kind: 'bullet', icon: 'listBullets', label: 'Список' },
  { kind: 'ordered', icon: 'listNumbers', label: 'Нумерованный список' },
  { kind: 'task', icon: 'tasks', label: 'Чекбоксы' },
];

export function EditorToolbar({ snap, compact, onCommand, onImage, canUpload, extra }: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [hrefError, setHrefError] = useState<string | null>(null);
  const pop = usePopover<HTMLButtonElement>({ align: 'start' });

  const pressed = (on: boolean) => ({ 'aria-pressed': on, className: on ? 'ne-tb-on' : undefined });
  const marks = snap?.marks;

  const toggleBlock = (kind: BlockKind) => onCommand(snap?.block === kind ? cmd.setBlock('paragraph') : cmd.setBlock(kind));

  return (
    <div className={`ne-toolbar${compact ? ' ne-toolbar--compact' : ''}`} role="toolbar" aria-label="Форматирование">
      {!compact &&
        BLOCKS.map((b) => (
          <IconButton key={b.kind} icon={b.icon} label={b.label} size={30} iconSize={16} onClick={() => toggleBlock(b.kind)} {...pressed(snap?.block === b.kind)} />
        ))}
      {!compact && <span className="ne-tb-sep" aria-hidden />}
      <IconButton icon="textB" label="Жирный (Ctrl+B)" size={30} iconSize={16} onClick={() => onCommand(cmd.bold)} {...pressed(!!marks?.bold)} />
      <IconButton icon="textItalic" label="Курсив (Ctrl+I)" size={30} iconSize={16} onClick={() => onCommand(cmd.italic)} {...pressed(!!marks?.italic)} />
      {!compact && (
        <>
          <IconButton icon="textUnderline" label="Подчёркнутый (Ctrl+U)" size={30} iconSize={16} onClick={() => onCommand(cmd.underline)} {...pressed(!!marks?.underline)} />
          <IconButton icon="textStrike" label="Зачёркнутый" size={30} iconSize={16} onClick={() => onCommand(cmd.strike)} {...pressed(!!marks?.strike)} />
          <IconButton icon="code" label="Код" size={30} iconSize={16} onClick={() => onCommand(cmd.code)} {...pressed(!!marks?.code)} />
        </>
      )}
      <span className="ne-tb-sep" aria-hidden />
      {LISTS.map((l) => (
        <IconButton key={l.kind} icon={l.icon} label={l.label} size={30} iconSize={16} onClick={() => onCommand(cmd.toggleList(l.kind))} {...pressed(snap?.list === l.kind)} />
      ))}
      {!compact && (
        <>
          <IconButton icon="quotes" label="Цитата" size={30} iconSize={16} onClick={() => onCommand(cmd.toggleBlockquote)} {...pressed(!!snap?.quote)} />
          <IconButton icon="code" label="Блок кода" size={30} iconSize={16} onClick={() => toggleBlock('codeBlock')} {...pressed(snap?.block === 'codeBlock')} />
          <span className="ne-tb-sep" aria-hidden />
          <IconButton
            ref={pop.anchorRef}
            icon="link"
            label={marks?.link ? 'Убрать ссылку' : 'Ссылка (выделите текст)'}
            size={30}
            iconSize={16}
            disabled={!snap?.hasSelection && !marks?.link}
            onClick={() => {
              if (marks?.link) onCommand(cmd.setLink(null));
              else {
                setHref(snap?.linkHref ?? '');
                setLinkOpen(true);
                pop.setOpen(true);
              }
            }}
            {...pressed(!!marks?.link)}
          />
          {canUpload && <IconButton icon="image" label="Картинка" size={30} iconSize={16} onClick={onImage} />}
          {snap?.inTable ? (
            // Внутри таблицы кнопка «вставить» бесполезна — нужны строки, колонки и удаление
            <Menu
              label="Таблица"
              items={[
                { key: 'row-before', label: 'Строка выше', icon: 'arrowUp', onClick: () => onCommand(cmd.addRowBefore) },
                { key: 'row-after', label: 'Строка ниже', icon: 'arrowDown', onClick: () => onCommand(cmd.addRowAfter) },
                { key: 'row-del', label: 'Удалить строку', icon: 'minus', onClick: () => onCommand(cmd.deleteRow) },
                { key: 'col-before', label: 'Колонка слева', icon: 'arrowLeft', onClick: () => onCommand(cmd.addColumnBefore), separatorBefore: true },
                { key: 'col-after', label: 'Колонка справа', icon: 'arrowRight', onClick: () => onCommand(cmd.addColumnAfter) },
                { key: 'col-del', label: 'Удалить колонку', icon: 'minus', onClick: () => onCommand(cmd.deleteColumn) },
                { key: 'header', label: 'Строка-заголовок', icon: 'table', onClick: () => onCommand(cmd.toggleHeaderRow), separatorBefore: true },
                { key: 'merge', label: 'Объединить ячейки', icon: 'table', onClick: () => onCommand(cmd.mergeCells) },
                { key: 'split', label: 'Разделить ячейку', icon: 'table', onClick: () => onCommand(cmd.splitCell) },
                { key: 'drop', label: 'Удалить таблицу', icon: 'delete', danger: true, onClick: () => onCommand(cmd.deleteTable), separatorBefore: true },
              ]}
              trigger={({ ref, onClick, ...aria }) => (
                <IconButton ref={ref} icon="table" label="Действия с таблицей" size={30} iconSize={16} onClick={onClick} {...aria} className="ne-tb-on" />
              )}
            />
          ) : (
            <IconButton icon="table" label="Таблица 3×3" size={30} iconSize={16} onClick={() => onCommand(cmd.insertTable(3, 3))} />
          )}
          <IconButton icon="minus" label="Разделитель" size={30} iconSize={16} onClick={() => onCommand(cmd.insertHorizontalRule)} />
        </>
      )}
      {extra && (
        <>
          <span className="ne-tb-grow" aria-hidden />
          {extra}
        </>
      )}
      {linkOpen && pop.open && (
        <div ref={pop.layerRef} style={pop.layerStyle} className="ne-link-pop card-elevated">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // Тот же белый список схем, что у документа и рендера (@superapp/shared)
              const v = normalizeNoteHref(href);
              if (v) {
                onCommand(cmd.setLink(v));
                setLinkOpen(false);
                pop.setOpen(false);
              } else {
                setHrefError(href.trim() ? 'Такой адрес нельзя вставить: только http(s), mailto, tel или путь внутри приложения' : 'Введите адрес');
              }
            }}
            style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end' }}
          >
            <Input
              label="Адрес ссылки"
              placeholder="https://…"
              value={href}
              onChange={(e) => {
                setHref(e.target.value);
                if (hrefError) setHrefError(null);
              }}
              error={hrefError ?? undefined}
              autoFocus
            />
            <Button type="submit" size="sm">Готово</Button>
          </form>
        </div>
      )}
    </div>
  );
}
