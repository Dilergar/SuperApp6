// Drag-and-drop payload shared across the triage panel and grid views.
// We keep the payload in a module variable (reliable for rich objects) and use
// the HTML5 dnd only to enable the drag gesture itself.

export type DragItem =
  | { kind: 'task'; id: string; title: string }
  | {
      kind: 'event';
      id: string;
      seriesId: string | null;
      recurring: boolean;
      occurrenceStart: string;
      start: string;
      durationMs: number;
      title: string;
    };

let current: DragItem | null = null;

export function setDrag(item: DragItem, e: React.DragEvent) {
  current = item;
  try {
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'move';
  } catch {
    /* some browsers restrict during dragstart — module var still carries it */
  }
}

export function getDrag(): DragItem | null {
  return current;
}

export function clearDrag() {
  current = null;
}
