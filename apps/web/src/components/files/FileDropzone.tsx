'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  /** accept для системного пикера, напр. "image/*" */
  accept?: string;
  multiple?: boolean;
  /** Ловить Ctrl+V со скриншотами/файлами на всей странице */
  paste?: boolean;
  label?: string;
  hint?: string;
  compact?: boolean;
  disabled?: boolean;
}

/**
 * Переиспользуемая зона загрузки: клик → системный пикер, drag&drop, опционально
 * вставка из буфера (Ctrl+V — скриншоты). Кирпич движка файлов (как EntitySelector).
 */
export function FileDropzone({
  onFiles,
  accept,
  multiple = true,
  paste = false,
  label = 'Перетащи файлы сюда или нажми',
  hint,
  compact = false,
  disabled = false,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const emit = useCallback(
    (list: FileList | File[] | null | undefined) => {
      if (!list) return;
      const files = Array.from(list);
      if (files.length) onFiles(multiple ? files : files.slice(0, 1));
    },
    [onFiles, multiple],
  );

  useEffect(() => {
    if (!paste || disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length) {
        e.preventDefault();
        emit(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [paste, disabled, emit]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) emit(e.dataTransfer?.files);
      }}
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: compact ? '0.75rem 1rem' : '1.75rem 1.25rem',
        textAlign: 'center',
        background: over ? 'var(--secondary-container)' : 'var(--surface-container-low)',
        border: `2px dashed ${over ? 'var(--secondary)' : 'var(--outline-variant)'}`,
        borderRadius: 'var(--radius-sketch)',
        transition: 'background 0.15s ease, border-color 0.15s ease',
        opacity: disabled ? 0.6 : 1,
        userSelect: 'none',
      }}
    >
      <div style={{ fontSize: compact ? '1.1rem' : '1.6rem', lineHeight: 1 }}>📎</div>
      <div
        style={{
          marginTop: '0.4rem',
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          fontSize: compact ? '0.8rem' : '0.9rem',
          color: 'var(--on-surface)',
        }}
      >
        {label}
      </div>
      {(hint || paste) && (
        <div style={{ marginTop: '0.2rem', fontSize: '0.72rem', color: 'var(--on-surface-variant)' }}>
          {hint ?? 'Можно вставить из буфера — Ctrl+V'}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(e) => {
          emit(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
