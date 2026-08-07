import tsParser from '@typescript-eslint/parser';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

// ============================================================
// МЕХАНИЧЕСКИЙ СТРАЖ ГРАНИЦЫ API ↔ клиент (третий эшелон защиты).
//
// Первые два — компилятор (тип из @superapp/shared стоит на обеих сторонах) и
// правила CLAUDE.md. Оба обходятся одним движением: достаточно написать
// `api.get(...).data.data as X` — и проверка выключена, а поле, переименованное
// на сервере, молча становится undefined на экране. Прошлое mobile-приложение
// умерло именно так, и веб успел разъехаться в десятке мест.
//
// Здесь НЕТ стилистики: конфиг знает ровно те правила, которые нельзя удержать
// договорённостью. Всё, что ловит компилятор, тут не дублируется.
// ============================================================

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'public/**', 'scripts/**'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // Плагины подключены ТОЛЬКО чтобы имена правил разрешались: в коде есть
    // `eslint-disable-next-line @next/next/no-img-element` и `react-hooks/…`,
    // а ESLint 9 считает ошибкой директиву к неизвестному правилу. Сами правила
    // выключены — они живут в `next lint`, здесь только страж границы.
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='api'][callee.property.name=/^(get|post|patch|put|delete)$/]",
          message:
            'Голый api.get/post/... запрещён. Ходите в API хелперами apiGet<T>/apiPost<T>/… из @/lib/api: тип T берётся из @superapp/shared и стоит на ОБЕИХ сторонах провода. Транспортные края (загрузка файлов) — тоже через хелперы, они принимают config.',
        },
        {
          selector: "MemberExpression[property.name='data'][object.property.name='data']",
          message:
            'Конверт { success, data } распаковывают хелперы транспорта. `res.data.data` — это каст мимо компилятора: поле, переименованное на сервере, станет undefined молча.',
        },
        {
          // Тот же конверт в маскировке деструктуризации: `const { data } = await …;
          // data.data` — первый селектор его не видит (object тут Identifier, а не
          // MemberExpression). Ровно так жил нетипизированный гостевой клиент.
          selector: "MemberExpression[property.name='data'][object.name='data']",
          message:
            'Конверт { success, data } распаковывают хелперы транспорта — `data.data` после деструктуризации это тот же обход компилятора, что и `res.data.data`.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'confirm',
          message:
            'Нативный confirm() запрещён: браузерная галочка «блокировать диалоги» заставляет его молча возвращать false — кнопка удаления перестаёт работать без единого признака. Используйте useConfirm() из components/ui.',
        },
        {
          name: 'alert',
          message:
            'Нативный alert() запрещён по той же причине: подавленный диалог делает сбой невидимым, и неудача выглядит как удача. Используйте toastError() из lib/toast.',
        },
      ],
    },
  },
  {
    // Гостевой клиент (/s/<токен>) — осознанно ОТДЕЛЬНЫЙ axios без перехватчиков
    // (второй ремень против 401-ловушки), поэтому конверт он распаковывает сам — в
    // ДВУХ типизированных хелперах guestGet/guestPost с `ApiOk<T>` из shared. Здесь
    // ослаблены только data.data-селекторы; запрет голого `api.*` действует и тут.
    // Прежний override целиком выключал правило для src/lib/api.ts — он протух:
    // тонкий адаптер больше не содержит ни вызовов инстанса, ни распаковки конверта.
    files: ['src/lib/public-api.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='api'][callee.property.name=/^(get|post|patch|put|delete)$/]",
          message:
            'Голый api.get/post/... запрещён. Ходите в API хелперами apiGet<T>/apiPost<T>/… из @/lib/api: тип T берётся из @superapp/shared и стоит на ОБЕИХ сторонах провода.',
        },
      ],
    },
  },
];
