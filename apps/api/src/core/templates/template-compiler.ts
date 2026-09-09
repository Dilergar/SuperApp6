import type { TemplateIssueDto, TemplateTagDto } from '@superapp/shared';
import { TEMPLATE_INDEX_TAG } from '@superapp/shared';
import { isKnownFormatter } from './template-formatters';
import type { TemplateFieldRegistry } from './template-field.registry';
import type { TemplateExtractResult } from './template.types';

/**
 * Компилятор шаблона: структурные замечания драйвера + сверка тегов с реестром
 * полей. Ловит опечатки ДО первого формирования — сотрудник, сохранивший шаблон
 * с «{Оргнизация.БИН}», узнаёт об этом сразу, а не из пустого приказа.
 *
 * extraPaths — пути, известные ВНЕ реестра: поля формы шаблона и ключи
 * коллекций («Строки») принесёт сервис «Документы» (Этап 4). Внутри повтора
 * поля элемента пишутся без префикса и валидируются только против префиксов
 * реестра: форму элемента компилятор не знает и честно молчит.
 */
export function checkTagsAgainstRegistry(
  extract: TemplateExtractResult,
  registry: TemplateFieldRegistry,
  extraPaths: string[] = [],
): { tags: TemplateTagDto[]; issues: TemplateIssueDto[] } {
  const issues: TemplateIssueDto[] = [...extract.issues];
  const extra = new Set(extraPaths);
  // Глубина повтора считается ПО ЧАСТЯМ: extractTags отдаёт теги части по порядку
  const depthByPart = new Map<string, number>();

  for (const tag of extract.tags) {
    const depth = depthByPart.get(tag.part) ?? 0;
    if (tag.kind === 'repeat_open') {
      depthByPart.set(tag.part, depth + 1);
      if (!extra.has(tag.path)) {
        issues.push({
          code: 'unknown_field',
          messageKey: 'templates.unknownCollection',
          params: { path: tag.path },
          tag: tag.raw,
          part: tag.part,
        });
      }
      continue;
    }
    if (tag.kind === 'repeat_close') {
      depthByPart.set(tag.part, Math.max(0, depth - 1));
      continue;
    }

    for (const f of tag.formatters) {
      if (!isKnownFormatter(f.key, f.arg)) {
        issues.push({
          code: 'unknown_formatter',
          messageKey: 'templates.unknownFormatter',
          params: { formatter: `${f.key}${f.arg ? ':' + f.arg : ''}`, tag: tag.raw },
          tag: tag.raw,
          part: tag.part,
        });
      }
    }

    if (extra.has(tag.path)) continue;
    const dot = tag.path.indexOf('.');
    if (dot < 0) {
      // Голый путь: внутри повтора — поле элемента (не проверяем), {No} — номер строки
      if (depth > 0) continue;
      if (tag.path === TEMPLATE_INDEX_TAG) {
        issues.push({
          code: 'unknown_field',
          messageKey: 'templates.indexOutsideRepeat',
          params: { tag: `{${TEMPLATE_INDEX_TAG}}` },
          tag: tag.raw,
          part: tag.part,
        });
        continue;
      }
      issues.push({
        code: 'unknown_field',
        messageKey: 'templates.fieldWithoutGroup',
        // Примеры групп берём у самого реестра: список групп растёт (Счёт, Договор…),
        // и зашитая в фразу пара имён устарела бы молча.
        params: { path: tag.path, groups: [...registry.prefixes()].slice(0, 2).join(', ') },
        tag: tag.raw,
        part: tag.part,
      });
      continue;
    }
    const prefix = tag.path.slice(0, dot);
    if (!registry.hasPrefix(prefix)) {
      issues.push({
        code: 'unknown_field',
        messageKey: 'templates.unknownGroup',
        params: { prefix, tag: tag.raw },
        tag: tag.raw,
        part: tag.part,
      });
      continue;
    }
    if (!registry.isKnownPath(tag.path)) {
      issues.push({
        code: 'unknown_field',
        messageKey: 'templates.unknownFieldInGroup',
        params: { prefix, field: tag.path.slice(dot + 1), tag: tag.raw },
        tag: tag.raw,
        part: tag.part,
      });
    }
  }

  return { tags: extract.tags, issues };
}
