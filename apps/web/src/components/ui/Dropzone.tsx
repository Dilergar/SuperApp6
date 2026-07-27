'use client';

// ============================================================
// Dropzone — визуальная зона перетаскивания файлов.
//
// Это ПРИМИТИВ вида: загрузку (профили, прогресс, отмену) делает
// components/files/*, которые опираются на движок core/files.
//
// Грабля: dragover обязан вызывать preventDefault(), иначе браузер
// не даст сработать drop.
// ============================================================
import { useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx, toneVars, type Tone } from './tones';

export interface DropzoneProps {
  onFiles: (files: File[]) => void;
  /** Текст под иконкой; по умолчанию — «Перетащите файлы или выберите». */
  title?: ReactNode;
  /** Подпись-капс снизу (например, «МАКС. РАЗМЕР: 20 МБ»). */
  note?: string;
  icon?: IconName;
  tone?: Tone;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Dropzone({
  onFiles,
  title,
  note,
  icon = 'upload',
  tone = 'warning',
  accept,
  multiple = true,
  disabled,
  className,
  children,
}: DropzoneProps) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function take(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length) onFiles(files);
  }

  return (
    <div
      className={cx('ui-dropzone', className)}
      data-drag={drag ? 'true' : 'false'}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => {
        e.preventDefault();
        // dragleave всплывает от каждого ребёнка зоны — гасим подсветку только
        // когда курсор реально покинул зону, иначе она мигает при проводке файла.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDrag(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDrag(false);
        take(e.dataTransfer.files);
      }}
      style={disabled ? { opacity: 0.6 } : undefined}
    >
      <span
        style={{
          ...toneVars(tone),
          width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 'var(--radius-md)',
          background: 'var(--tone-bg)', border: '1px solid var(--tone-border)', color: 'var(--tone-fg)',
        }}
      >
        <Icon name={icon} size={21} />
      </span>

      <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--on-surface-variant)' }}>
        {title ?? (
          <>
            Перетащите файлы или{' '}
            <button type="button" className="ui-dropzone-link" disabled={disabled} onClick={() => inputRef.current?.click()}>
              выберите
            </button>
          </>
        )}
      </div>

      {note && <div className="label-caps">{note}</div>}
      {children}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => { take(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
