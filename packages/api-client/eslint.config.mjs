import tsParser from '@typescript-eslint/parser';
import noCyrillicLiteral from '../../scripts/eslint-rules/no-cyrillic-literal.cjs';

// Пакет-провод: хелперы запросов и типы ответов, слов для человека здесь быть не
// должно вовсе. Ратчета у него нет намеренно — переводить нечего, и первая же
// русская строка обязана падать сразу, а не заводить список исключений.
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { i18n: { rules: { 'no-cyrillic-literal': noCyrillicLiteral } } },
    rules: { 'i18n/no-cyrillic-literal': 'error' },
  },
];
