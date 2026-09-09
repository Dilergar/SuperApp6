import type { DocCategory } from '@superapp/shared';
import { DOC_CATEGORY_SURFACE } from '@superapp/shared';

// ============================================================
// Заготовка маршрута документа.
//
// Кнопка «Маршрут» не отправляет кадровика на пустой холст: она заводит процесс,
// в котором уже расставлены нужные шаги и проставлен ЭТОТ шаблон в триггере.
// Остаётся указать, кто подписывает, — а не собирать схему с нуля из палитры.
//
// Порядок шагов — кадровый минимум ТК РК, тот же, что проверяют правила
// профиля `documents.hr`: подпись → ознакомление сотрудника → номер → дело.
// ============================================================

export interface BlueprintNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface BlueprintDoc {
  nodes: BlueprintNode[];
  edges: { id: string; from: string; fromPort?: string; to: string; toPort?: string }[];
  form: never[];
}

/**
 * Подписи шагов заготовки. Слова приходят СВЕРХУ, из каталога: маршрут дальше
 * правит человек, и подписи он читает и меняет на своём языке.
 */
export interface RouteBlueprintLabels {
  trigger: string;
  sign: string;
  signTitle: string;
  ack: string;
  ackTitle: string;
  register: string;
  file: string;
  done: string;
  refused: string;
}

/**
 * @param templateId — шаблон, отправка по которому запускает маршрут
 * @param labels — подписи шагов на языке того, кто рисует маршрут
 * @param signatureLevel — чем подписывается ВИД документа (core/sign). Подставляем
 *   в шаг «Подписать» сразу: кадровику не приходится знать, что ст. 33 ТК РК
 *   требует ЭЦП, а забыть выбрать уровень — значит получить приказ, «подписанный»
 *   нажатием кнопки.
 */
export function buildRouteBlueprint(
  templateId: string,
  labels: RouteBlueprintLabels,
  signatureLevel: 'none' | 'pep' | 'ecp' = 'none',
): BlueprintDoc {
  const nodes: BlueprintNode[] = [
    {
      id: 'trigger',
      type: 'trigger.document',
      label: labels.trigger,
      config: { templateId },
      position: { x: 80, y: 160 },
    },
    {
      id: 'sign',
      type: 'human.approval',
      label: labels.sign,
      config: {
        kind: 'signature',
        signatureLevel,
        title: labels.signTitle,
        // Кто подписывает — единственное, что человек обязан указать сам: у каждой
        // компании это своя должность, и угадывать её за неё нельзя.
        assigneeMode: 'position',
        rule: 'any',
      },
      position: { x: 380, y: 160 },
    },
    {
      id: 'ack',
      type: 'human.approval',
      label: labels.ack,
      config: {
        kind: 'acknowledgement',
        title: labels.ackTitle,
        assigneeMode: 'initiator',
      },
      position: { x: 680, y: 160 },
    },
    {
      id: 'register',
      type: 'doc.register',
      label: labels.register,
      config: {},
      position: { x: 980, y: 160 },
    },
    {
      id: 'file',
      type: 'doc.file',
      label: labels.file,
      config: {},
      position: { x: 1240, y: 160 },
    },
    { id: 'done', type: 'end', label: labels.done, config: {}, position: { x: 1500, y: 160 } },
    // Отказ — тоже конец пути, и он должен быть виден на схеме, а не подразумеваться.
    { id: 'refused', type: 'end', label: labels.refused, config: {}, position: { x: 380, y: 360 } },
  ];

  const edges = [
    { id: 'e1', from: 'trigger', fromPort: 'main', to: 'sign', toPort: 'main' },
    { id: 'e2', from: 'sign', fromPort: 'approved', to: 'ack', toPort: 'main' },
    { id: 'e3', from: 'sign', fromPort: 'rejected', to: 'refused', toPort: 'main' },
    { id: 'e4', from: 'ack', fromPort: 'approved', to: 'register', toPort: 'main' },
    // У ознакомления отказа по смыслу нет, но выход у ноды есть — и незакрытый порт
    // держал бы маршрут неопубликованным. Ведём туда же, куда и отказ в подписи.
    { id: 'e7', from: 'ack', fromPort: 'rejected', to: 'refused', toPort: 'main' },
    { id: 'e5', from: 'register', fromPort: 'main', to: 'file', toPort: 'main' },
    { id: 'e6', from: 'file', fromPort: 'main', to: 'done', toPort: 'main' },
  ];

  return { nodes, edges, form: [] };
}

/** Профиль редактора по категории вида: кадровый показывает 7 нод из 32 */
export function surfaceOfCategory(category: DocCategory): string {
  return DOC_CATEGORY_SURFACE[category] ?? 'documents.general';
}
