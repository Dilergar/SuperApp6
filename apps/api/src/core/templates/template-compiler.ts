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
          message: `Коллекция повтора «${tag.path}» не найдена среди полей формы шаблона`,
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
          message: `Неизвестный форматтер «${f.key}${f.arg ? ':' + f.arg : ''}» в теге ${tag.raw}`,
          tag: tag.raw,
          part: tag.part,
        });
      }
    }

    if (extra.has(tag.path)) continue;
    const dot = tag.path.indexOf('.');
    if (dot < 0) {
      // Голый путь: внутри повтора — поле элемента (не проверяем), {№} — номер строки
      if (depth > 0) continue;
      if (tag.path === TEMPLATE_INDEX_TAG) {
        issues.push({
          code: 'unknown_field',
          message: `{${TEMPLATE_INDEX_TAG}} работает только внутри повтора {#…}…{/…}`,
          tag: tag.raw,
          part: tag.part,
        });
        continue;
      }
      issues.push({
        code: 'unknown_field',
        message: `Поле «${tag.path}» не найдено — укажите группу («Организация.…», «Сотрудник.…») или добавьте поле в форму шаблона`,
        tag: tag.raw,
        part: tag.part,
      });
      continue;
    }
    const prefix = tag.path.slice(0, dot);
    if (!registry.hasPrefix(prefix)) {
      issues.push({
        code: 'unknown_field',
        message: `Группа «${prefix}» не существует (тег ${tag.raw}) — проверьте написание`,
        tag: tag.raw,
        part: tag.part,
      });
      continue;
    }
    if (!registry.isKnownPath(tag.path)) {
      issues.push({
        code: 'unknown_field',
        message: `В группе «${prefix}» нет поля «${tag.path.slice(dot + 1)}» (тег ${tag.raw})`,
        tag: tag.raw,
        part: tag.part,
      });
    }
  }

  return { tags: extract.tags, issues };
}
