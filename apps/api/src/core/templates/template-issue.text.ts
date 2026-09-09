import type { TemplateIssueDto } from '@superapp/shared';
import type { I18nService } from '../../shared/i18n/i18n.service';

/**
 * ЕДИНСТВЕННАЯ точка, где замечание компилятора становится СЛОВАМИ.
 *
 * Драйвер и компилятор языка запроса не знают (их зовёт и джоб пересборки), и
 * складывать в замечание готовую фразу значило бы зашить в неё один язык. Они
 * кладут ключ каталога и параметры, а слово подбирается здесь — на выходе, в
 * языке того, кто читает список.
 *
 * `message` (готовая фраза) остаётся у замечаний блочного конструктора: они
 * называют имена полей БЛАНКА, а бланки и их DSL — отдельный трек миграции.
 */
export function templateIssueText(i18n: I18nService, issue: TemplateIssueDto): string {
  if (issue.messageKey) return i18n.translate(`errors.${issue.messageKey}`, issue.params);
  return issue.message ?? issue.code;
}
