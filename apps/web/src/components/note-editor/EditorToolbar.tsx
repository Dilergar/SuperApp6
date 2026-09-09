'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
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

// Реестр называет ВИД блока и его значок; слово ему даёт каталог (`notes.editor.*`).
const BLOCKS: Array<{ kind: BlockKind; icon: IconName }> = [
  { kind: 'heading1', icon: 'headingOne' },
  { kind: 'heading2', icon: 'headingTwo' },
  { kind: 'heading3', icon: 'headingThree' },
];

const LISTS: Array<{ kind: ListKind; icon: IconName }> = [
  { kind: 'bullet', icon: 'listBullets' },
  { kind: 'ordered', icon: 'listNumbers' },
  { kind: 'task', icon: 'tasks' },
];

export function EditorToolbar({ snap, compact, onCommand, onImage, canUpload, extra }: Props) {
  const t = useTranslations('notes');
  const tc = useTranslations('common');
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [hrefError, setHrefError] = useState<string | null>(null);
  const pop = usePopover<HTMLButtonElement>({ align: 'start' });

  const pressed = (on: boolean) => ({ 'aria-pressed': on, className: on ? 'ne-tb-on' : undefined });
  const marks = snap?.marks;

  const toggleBlock = (kind: BlockKind) => onCommand(snap?.block === kind ? cmd.setBlock('paragraph') : cmd.setBlock(kind));

  return (
    <div className={`ne-toolbar${compact ? ' ne-toolbar--compact' : ''}`} role="toolbar" aria-label={t('editor.toolbarAria')}>
      {!compact &&
        BLOCKS.map((b) => (
          <IconButton key={b.kind} icon={b.icon} label={t(`editor.${b.kind}`)} size={30} iconSize={16} onClick={() => toggleBlock(b.kind)} {...pressed(snap?.block === b.kind)} />
        ))}
      {!compact && <span className="ne-tb-sep" aria-hidden />}
      <IconButton icon="textB" label={t('editor.bold')} size={30} iconSize={16} onClick={() => onCommand(cmd.bold)} {...pressed(!!marks?.bold)} />
      <IconButton icon="textItalic" label={t('editor.italic')} size={30} iconSize={16} onClick={() => onCommand(cmd.italic)} {...pressed(!!marks?.italic)} />
      {!compact && (
        <>
          <IconButton icon="textUnderline" label={t('editor.underline')} size={30} iconSize={16} onClick={() => onCommand(cmd.underline)} {...pressed(!!marks?.underline)} />
          <IconButton icon="textStrike" label={t('editor.strike')} size={30} iconSize={16} onClick={() => onCommand(cmd.strike)} {...pressed(!!marks?.strike)} />
          <IconButton icon="code" label={t('editor.code')} size={30} iconSize={16} onClick={() => onCommand(cmd.code)} {...pressed(!!marks?.code)} />
        </>
      )}
      <span className="ne-tb-sep" aria-hidden />
      {LISTS.map((l) => (
        <IconButton key={l.kind} icon={l.icon} label={t(`editor.${l.kind}`)} size={30} iconSize={16} onClick={() => onCommand(cmd.toggleList(l.kind))} {...pressed(snap?.list === l.kind)} />
      ))}
      {!compact && (
        <>
          <IconButton icon="quotes" label={t('editor.quote')} size={30} iconSize={16} onClick={() => onCommand(cmd.toggleBlockquote)} {...pressed(!!snap?.quote)} />
          <IconButton icon="code" label={t('editor.codeBlock')} size={30} iconSize={16} onClick={() => toggleBlock('codeBlock')} {...pressed(snap?.block === 'codeBlock')} />
          <span className="ne-tb-sep" aria-hidden />
          <IconButton
            ref={pop.anchorRef}
            icon="link"
            label={t(marks?.link ? 'editor.linkRemove' : 'editor.linkAdd')}
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
          {canUpload && <IconButton icon="image" label={t('editor.image')} size={30} iconSize={16} onClick={onImage} />}
          {snap?.inTable ? (
            // Внутри таблицы кнопка «вставить» бесполезна — нужны строки, колонки и удаление
            <Menu
              label={t('editor.table')}
              items={[
                { key: 'row-before', label: t('editor.rowBefore'), icon: 'arrowUp', onClick: () => onCommand(cmd.addRowBefore) },
                { key: 'row-after', label: t('editor.rowAfter'), icon: 'arrowDown', onClick: () => onCommand(cmd.addRowAfter) },
                { key: 'row-del', label: t('editor.rowDelete'), icon: 'minus', onClick: () => onCommand(cmd.deleteRow) },
                { key: 'col-before', label: t('editor.colBefore'), icon: 'arrowLeft', onClick: () => onCommand(cmd.addColumnBefore), separatorBefore: true },
                { key: 'col-after', label: t('editor.colAfter'), icon: 'arrowRight', onClick: () => onCommand(cmd.addColumnAfter) },
                { key: 'col-del', label: t('editor.colDelete'), icon: 'minus', onClick: () => onCommand(cmd.deleteColumn) },
                { key: 'header', label: t('editor.headerRow'), icon: 'table', onClick: () => onCommand(cmd.toggleHeaderRow), separatorBefore: true },
                { key: 'merge', label: t('editor.mergeCells'), icon: 'table', onClick: () => onCommand(cmd.mergeCells) },
                { key: 'split', label: t('editor.splitCell'), icon: 'table', onClick: () => onCommand(cmd.splitCell) },
                { key: 'drop', label: t('editor.dropTable'), icon: 'delete', danger: true, onClick: () => onCommand(cmd.deleteTable), separatorBefore: true },
              ]}
              trigger={({ ref, onClick, ...aria }) => (
                <IconButton ref={ref} icon="table" label={t('editor.tableActions')} size={30} iconSize={16} onClick={onClick} {...aria} className="ne-tb-on" />
              )}
            />
          ) : (
            <IconButton icon="table" label={t('editor.table33')} size={30} iconSize={16} onClick={() => onCommand(cmd.insertTable(3, 3))} />
          )}
          <IconButton icon="minus" label={t('editor.divider')} size={30} iconSize={16} onClick={() => onCommand(cmd.insertHorizontalRule)} />
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
                setHrefError(t(href.trim() ? 'editor.linkInvalid' : 'editor.linkEmpty'));
              }
            }}
            style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end' }}
          >
            <Input
              label={t('editor.linkLabel')}
              placeholder="https://…"
              value={href}
              onChange={(e) => {
                setHref(e.target.value);
                if (hrefError) setHrefError(null);
              }}
              error={hrefError ?? undefined}
              autoFocus
            />
            <Button type="submit" size="sm">{tc('actions.done')}</Button>
          </form>
        </div>
      )}
    </div>
  );
}
