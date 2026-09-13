import tsParser from '@typescript-eslint/parser';
import noCyrillicLiteral from '../../scripts/eslint-rules/no-cyrillic-literal.cjs';

// SDK аналитики — транспорт и очередь, слов для человека здесь нет вовсе: первая же
// русская строка обязана падать сразу. Runtime-импорт из @superapp/shared запрещён —
// SDK без зависимостей (≤ 5 КБ gz), всё нужное из shared внедряется конфигом.
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { i18n: { rules: { 'no-cyrillic-literal': noCyrillicLiteral } } },
    rules: {
      'i18n/no-cyrillic-literal': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='@superapp/shared'][importKind!='type']",
          message: 'SDK imports @superapp/shared only as `import type`: runtime values are injected through the config.',
        },
      ],
    },
  },
];
