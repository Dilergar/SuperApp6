#!/usr/bin/env node
// ============================================================
// e2e-сьют мультиязычности. Запускать при ЖИВОМ API:
//     node apps/api/scripts/verify-i18n.cjs
//
// Проверяет то, что ломается молча и только у одного языка:
//  1. отказ приходит на языке ЗАПРОСА и ВСЕГДА несёт details.code;
//  2. ДВА канала языка: явный выбор (`X-Locale`) сильнее маршрута рынка,
//     подсказка браузера (`Accept-Language`) ему подчиняется — kk и ru → kk,
//     en → en, незнакомый язык → en, гео-сигнал «человек в России» → ru;
//  3. ошибка валидации Zod переведена и несёт машинный код поля;
//  4. `User.locale` переключается ручкой профиля и переживает перезаход;
//  5. уведомление перерисовывается ПРИ ЧТЕНИИ: одна и та же строка приходит
//     по-русски и по-английски в зависимости от Accept-Language;
//  6. хроника отдаёт `text` (плоский рендер) И структуру (`changes[].raw`);
//  7. плашка задачи в ленте мессенджера — в языке запроса.
//
// Сьют НИКОГДА не чистит БД deleteMany: база живая (docs/testing_verify_suite.md).
// ============================================================
const { SUITE, call, login, makeChecker } = require('./_lib.cjs');

const { check, finish } = makeChecker();

/** ЯВНЫЙ выбор человека: маршрут рынка на него не действует. */
const lang = (locale) => ({ 'X-Locale': locale });

/**
 * ПОДСКАЗКА браузера: её сервер вправе маршрутизировать под рынок.
 * `X-Locale: null` снимает дефолтный заголовок обвязки — иначе явный выбор
 * сьюты перебил бы ровно то, что здесь проверяется.
 */
const browser = (acceptLanguage, country) => ({
  'X-Locale': null,
  'Accept-Language': acceptLanguage,
  ...(country ? { 'CF-IPCountry': country } : {}),
});

async function main() {
  const u1 = await login(SUITE.p1);
  const u2 = await login(SUITE.p2);

  // ---------- 1. Отказ на языке запроса + машинный код ----------
  {
    // Несуществующее уведомление: 404 с машинным кодом на трёх языках.
    const del = {
      ru: await call('DELETE', '/notifications/00000000-0000-0000-0000-000000000000', u1.token, null, lang('ru')),
      en: await call('DELETE', '/notifications/00000000-0000-0000-0000-000000000000', u1.token, null, lang('en')),
      kk: await call('DELETE', '/notifications/00000000-0000-0000-0000-000000000000', u1.token, null, lang('kk')),
    };
    check('404 у всех языков', Object.values(del).every((r) => r.status === 404), JSON.stringify(Object.fromEntries(Object.entries(del).map(([k, v]) => [k, v.status]))));
    check(
      'details.code есть ВСЕГДА',
      Object.values(del).every((r) => r.code === 'notification.notFound'),
      JSON.stringify(Object.fromEntries(Object.entries(del).map(([k, v]) => [k, v.code]))),
    );
    const msgs = Object.fromEntries(Object.entries(del).map(([k, v]) => [k, v.json?.message]));
    check('текст отказа РАЗНЫЙ на ru/en/kk', new Set([msgs.ru, msgs.en, msgs.kk]).size === 3, JSON.stringify(msgs));
  }

  // ---------- 1b. Маршрут рынка действует на ПОДСКАЗКУ браузера ----------
  {
    const url = '/notifications/00000000-0000-0000-0000-000000000000';
    const ask = (headers) => call('DELETE', url, u1.token, null, headers);
    // Эталоны: явный выбор человека маршруту не подчиняется.
    const KK = (await ask(lang('kk'))).json?.message;
    const RU = (await ask(lang('ru'))).json?.message;
    const EN = (await ask(lang('en'))).json?.message;
    check('явный выбор даёт три РАЗНЫХ текста', new Set([KK, RU, EN]).size === 3, JSON.stringify({ KK, RU, EN }));

    const say = async (acceptLanguage, country) =>
      (await ask(browser(acceptLanguage, country))).json?.message;

    // Русская Windows шлёт `ru-RU` по всему миру, включая Казахстан: страна
    // неизвестна → государственный язык рынка.
    check('браузер ru-RU без гео → казахский', (await say('ru-RU,ru;q=0.9,en;q=0.8')) === KK);
    check('браузер kk-KZ → казахский', (await say('kk-KZ,kk;q=0.9')) === KK);
    check('браузер en-US → английский', (await say('en-US,en;q=0.9')) === EN);
    check('браузер de-DE (язык незнаком) → английский', (await say('de-DE,de;q=0.9')) === EN);
    check('браузер tr-TR (язык незнаком) → английский', (await say('tr-TR,tr')) === EN);
    // Гео-заголовок CDN: человек ДЕЙСТВИТЕЛЬНО в России и просит русский.
    check('браузер ru + гео RU → русский', (await say('ru-RU,ru;q=0.9', 'RU')) === RU);
    // Гео-сигнал НЕ навязывает язык, которого человек не просил.
    check('браузер en + гео RU → английский', (await say('en-US,en;q=0.9', 'RU')) === EN);
    // Явный выбор сильнее и маршрута, и гео.
    const chosenRu = (await ask({ ...browser('kk-KZ,kk', 'KZ'), ...lang('ru') })).json?.message;
    check('выбор человека сильнее браузера и гео', chosenRu === RU, `${chosenRu} vs ${RU}`);
  }

  // ---------- 2. Отказ гарда (до интерцептора) тоже переведён ----------
  {
    const r = await call('GET', '/tasks', u1.token, null, {
      ...lang('en'),
      'X-Workspace-Id': '00000000-0000-0000-0000-000000000000',
    });
    check('чужая организация → 403 с кодом workspace.noAccess', r.status === 403 && r.code === 'workspace.noAccess', `${r.status} ${r.code}`);
    check('403 переведён на en', typeof r.json?.message === 'string' && !/[А-Яа-я]/.test(r.json.message), r.json?.message);
  }

  // ---------- 3. Zod: перевод + код поля ----------
  {
    const r = await call('PATCH', '/users/me', u1.token, { locale: 'de' }, lang('en'));
    check('неизвестный язык отвергнут', r.status === 400, `${r.status}`);
    check('ошибка поля несёт код', (r.json?.errors ?? []).some((e) => typeof e.code === 'string' && e.code.startsWith('validation.')), JSON.stringify(r.json?.errors));
    check('конверт валидации несёт details.code', r.code === 'validation.failed', String(r.code));
  }

  // ---------- 4. User.locale переключается и переживает перезаход ----------
  const before = (await call('GET', '/users/me', u1.token, null, lang('ru'))).json?.data?.locale;
  try {
    await call('PATCH', '/users/me', u1.token, { locale: 'en' });
    const again = await login(SUITE.p1);
    const after = (await call('GET', '/users/me', again.token, null, lang('ru'))).json?.data?.locale;
    check('PATCH /users/me {locale} сохраняется', after === 'en', `${before} → ${after}`);
  } finally {
    // Возвращаем как было: база живая, соседние сьюты читают тот же аккаунт.
    if (before) await call('PATCH', '/users/me', u1.token, { locale: before });
  }

  // ---------- 5. Уведомление рендерится ПРИ ЧТЕНИИ ----------
  {
    const ru = await call('GET', '/notifications', u1.token, null, lang('ru'));
    const en = await call('GET', '/notifications', u1.token, null, lang('en'));
    const itemsRu = ru?.json?.data?.items ?? [];
    const itemsEn = new Map((en?.json?.data?.items ?? []).map((n) => [n.id, n]));
    check('та же страница ленты в обоих языках', itemsRu.length > 0 && itemsRu.every((n) => itemsEn.has(n.id)));
    // Ищем строку, у которой заголовок ДЕЙСТВИТЕЛЬНО отличается. Брать первую
    // попавшуюся нельзя: у части типов заголовок целиком состоит из плейсхолдеров
    // (`{outcomeLabel}: «{refTitle}»`), а их значения — ДАННЫЕ, и они одинаковы во
    // всех языках, пока не переведён сам сервис-эмиттер. Это не поломка рендера.
    const differing = itemsRu.filter((n) => n.title !== itemsEn.get(n.id)?.title);
    if (itemsRu.length === 0) {
      check('лента уведомлений не пуста (для проверки рендера)', false, 'заведите хоть одно уведомление у suite1');
    } else {
      const sample = differing[0];
      check(
        'есть строка, перерисованная при чтении',
        !!sample,
        sample
          ? `ru="${sample.title}" en="${itemsEn.get(sample.id).title}"`
          : `из ${itemsRu.length} строк ни одна не отличается — у всех заголовок из данных?`,
      );
    }
  }

  // ---------- 6–7. Хроника: text + raw; плашка в ленте ----------
  {
    const created = await call('POST', '/tasks', u1.token, {
      title: 'i18n verify ' + Date.now(),
      // Исполнитель нужен, чтобы у задачи появился чат (плашки проверяем ниже).
      executorId: u2.id,
    });
    if (!created.ok) {
      check('задача для проверки хроники создана', false, JSON.stringify(created.json));
    } else {
      const taskId = created.json.data.id;
      // Меняем срок — рождается запись хроники с changes[].raw
      const due = new Date(Date.now() + 3 * 86400_000).toISOString();
      await call('PATCH', `/tasks/${taskId}`, u1.token, { dueDate: due });

      const ru = await call('GET', `/chatter/task/${taskId}`, u1.token, null, lang('ru'));
      const en = await call('GET', `/chatter/task/${taskId}`, u1.token, null, lang('en'));
      const pick = (r) => (r.json?.data?.items ?? []).find((e) => e.typeKey === 'task.deadline_changed');
      const a = pick(ru);
      const b = pick(en);
      check('запись хроники о сроке создана', !!a, a ? a.typeKey : JSON.stringify(ru.json?.data?.items?.map((i) => i.typeKey)));
      if (a && b) {
        check('хроника отдаёт готовый text', typeof a.text === 'string' && a.text.length > 0, a.text);
        check('text переведён в языке запроса', a.text !== b.text, `ru="${a.text}" en="${b.text}"`);
        check(
          'changes[].raw несёт сырые значения',
          !!a.changes?.[0]?.raw && a.changes[0].raw.kind !== undefined,
          JSON.stringify(a.changes?.[0]?.raw),
        );
      }

      // Плашка в ленте чата задачи (проекция хроники джобом — ждём её появления).
      // Чат задачи создаётся лениво, поэтому сначала спрашиваем его у мессенджера.
      const taskChat = await call('GET', `/messenger/tasks/${taskId}/chat`, u1.token, null, lang('ru'));
      const chatId = taskChat.json?.data?.id ?? taskChat.json?.data?.chat?.id ?? null;
      let plaqueRu = null;
      let plaqueEn = null;
      const messages = (r) => {
        const d = r.json?.data;
        return Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
      };
      for (let i = 0; chatId && i < 20 && !plaqueRu; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const chat = await call('GET', `/messenger/chats/${chatId}/messages`, u1.token, null, lang('ru'));
        plaqueRu = messages(chat).find(
          (m) => m.type === 'system' && m.payload?.eventType === 'task.deadline_changed',
        );
      }
      if (plaqueRu) {
        const chatEn = await call('GET', `/messenger/chats/${chatId}/messages`, u1.token, null, lang('en'));
        const itemsEn = messages(chatEn);
        plaqueEn = itemsEn.find((m) => m.id === plaqueRu.id);
        check(
          'плашка чата — в языке запроса',
          !!plaqueEn && plaqueEn.payload?.text !== plaqueRu.payload?.text,
          `ru="${plaqueRu.payload?.text}" en="${plaqueEn?.payload?.text}"`,
        );
      } else {
        check('плашка хроники доехала в чат задачи', false, 'джоб chatter.chatpost не отработал за 10 с');
      }

      await call('DELETE', `/tasks/${taskId}`, u1.token);
    }
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
