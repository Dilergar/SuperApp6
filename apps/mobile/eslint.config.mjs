import tsParser from '@typescript-eslint/parser';
import noCyrillicLiteral from '../../scripts/eslint-rules/no-cyrillic-literal.cjs';

// ============================================================
// СТРАЖ МУЛЬТИЯЗЫЧНОСТИ мобильного клиента.
//
// Ратчета (`i18n.legacy.json`) здесь нет намеренно: экраны переведены целиком,
// и приложение переписывается заново на этапе 2 дорожной карты — список
// исключений успел бы только зарасти. Первая же русская строка падает сразу.
//
// Каталоги те же, что у веба (`@superapp/i18n`), провайдер один на приложение
// (`src/i18n/I18nProvider.tsx`): правило «неймспейс на страницу» — про RSC-пейлоад
// веба, а нативный бандл и так один.
// ============================================================
export default [
  { ignores: ['node_modules/**', '.expo/**', 'android/**', 'ios/**'] },
  {
    files: ['app/**/*.ts', 'app/**/*.tsx', 'src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { i18n: { rules: { 'no-cyrillic-literal': noCyrillicLiteral } } },
    rules: { 'i18n/no-cyrillic-literal': 'error' },
  },
];
