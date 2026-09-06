import tsParser from '@typescript-eslint/parser';
import noCyrillicLiteral from '../../scripts/eslint-rules/no-cyrillic-literal.cjs';

// ============================================================
// СТРАЖ МУЛЬТИЯЗЫЧНОСТИ для пакета ПРОВОДА.
//
// `@superapp/shared` — самое опасное место для литерала: реестры отсюда читают
// и API, и веб, и (завтра) мобильное приложение, поэтому одна русская подпись в
// реестре делает русскими сразу три клиента. Правило здесь и держит договор
// «shared называет СМЫСЛ, каталог даёт СЛОВА».
// ============================================================

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
      'i18n/no-cyrillic-literal': [
        'error',
        {
          allowFiles: [
            // Библиотека кадровых бланков РК: это платформенный КОНТЕНТ (тексты
            // приказов по ТК РК), а не интерфейс. Его перевод — отдельный трек
            // с юридической вычиткой, а не работа переводчика строк.
            'src/constants/hr-library.ts',
          ],
          // Автонимы языков — единственные строки продукта, которые не переводятся.
          allowIdentifiers: ['LOCALE_NAMES'],
        },
      ],
    },
  },
];
