// Дескрипторы слоёв календаря на вебе. Ярлыки/иконки/тона тумблеров приходят из
// shared-реестра (CALENDAR_LAYER_REGISTRY) — новый слой появляется в панели сам;
// здесь только веб-специфика: соответствие kind→слой, запасные иконки чипов и
// адрес клика для записей без своей модалки (контракт CalendarLayerItemBase).

import {
  CALENDAR_LAYER_KEYS,
  CALENDAR_LAYER_REGISTRY,
  type CalendarItem,
  type CalendarLayerKey,
} from '@superapp/shared';
import type { IconName, Tone } from '@/components/ui';

export interface LayerToggle {
  key: CalendarLayerKey;
  label: string;
  icon: IconName;
  tone: Tone;
}

/** Тумблеры панели управления — прямо из shared-реестра. */
export const LAYER_TOGGLES: LayerToggle[] = CALENDAR_LAYER_KEYS.map((key) => ({
  key,
  label: CALENDAR_LAYER_REGISTRY[key].label,
  icon: CALENDAR_LAYER_REGISTRY[key].icon as IconName,
  tone: CALENDAR_LAYER_REGISTRY[key].tone as Tone,
}));

/** kind записи → ключ слоя ('event'/'task' — легаси-единственное число; новые kind = ключ слоя). */
export const layerOfKind = (kind: string): string =>
  kind === 'event' ? 'events' : kind === 'task' ? 'tasks' : kind;

/** Запасная иконка чипа записи (когда у записи нет своего значка) — иконка её слоя. */
export function kindFallbackIcon(kind: string): IconName {
  const meta = (CALENDAR_LAYER_REGISTRY as Record<string, { icon: string }>)[layerOfKind(kind)];
  return (meta?.icon ?? 'calendar') as IconName;
}

/** Куда ведёт клик по записи без своей модалки (платежи и незнакомые слои). */
export function itemHref(i: CalendarItem): string {
  return (i as { href?: string }).href ?? '/';
}

/** Значок записи как значение Glyph (события/платежи/чужие слои несут поле icon). */
export function itemGlyph(i: CalendarItem): string | null {
  return (i as { icon?: string | null }).icon ?? null;
}
