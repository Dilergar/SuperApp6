'use client';

import { NOTE_COLORS } from '@superapp/shared';
import { IconButton, usePopover } from '@/components/ui';

// ============================================================
// Выбор цвета заметки — 8 пастельных цветов платформы (цвет-данные). Кнопка-палитра,
// сетка свотчей в поповере, «без цвета» первым.
// ============================================================

export function NoteColorMenu({ value, onChange, size = 30 }: { value: string | null; onChange: (color: string | null) => void; size?: number }) {
  const pop = usePopover<HTMLButtonElement>({ align: 'start' });
  return (
    <>
      <IconButton ref={pop.anchorRef} icon="palette" label="Цвет заметки" size={size} iconSize={16} onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open} />
      {pop.open && (
        <div ref={pop.layerRef} style={{ ...pop.layerStyle, width: 'auto', zIndex: 320 }} className="card-elevated" role="group" aria-label="Цвет заметки">
          <div className="note-color-grid" style={{ background: 'var(--block)', borderRadius: 'var(--radius-sm)' }}>
            <button
              type="button"
              className="note-color-swatch"
              aria-label="Без цвета"
              aria-pressed={value === null}
              style={{ background: 'var(--block)' }}
              onClick={() => {
                onChange(null);
                pop.setOpen(false);
              }}
            />
            {NOTE_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className="note-color-swatch"
                aria-label={c.name}
                aria-pressed={value === c.value}
                style={{ ['--note-color' as string]: c.value }}
                onClick={() => {
                  onChange(c.value);
                  pop.setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
