import tsParser from '@typescript-eslint/parser';
import noCyrillicLiteral from '../../scripts/eslint-rules/no-cyrillic-literal.cjs';

// Каталоги (JSON) правило не смотрит вовсе — оно про КОД. Здесь оно стережёт
// сам движок: ни одной готовой фразы в резолвере, загрузчике и форматтерах.
export default [
  { ignores: ['dist/**', 'node_modules/**', 'src/messages/**'] },
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
