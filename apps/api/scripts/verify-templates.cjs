/* eslint-disable */
// core/templates (Этап 3 «Документов») — сквозная проверка СВОЕГО docx-драйвера:
// сборка тега из разорванных Word'ом кусков, повтор строки таблицы, форматтеры,
// громкие отказы (компиляция + недостающие данные), реестр групп полей и живой
// резолв «Организация»/«Сотрудник» по реквизитам.
//
// Аккаунты СЬЮТА (+7700999000x). Уборка — только свои объекты и штатным путём:
// поля анкеты — PATCH null, организация — деактивация (архив приберёт
// gc-test-workspaces.cjs). Файлы не создаются вовсе — рендер ходит base64.
//
// Run (API up): node scripts/verify-templates.cjs
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

// Адрес API переопределяется переменной окружения: два экземпляра на одной машине
// (например, когда :3001 занят чужим дев-сервером) — обычная ситуация при проверке правок.
const BASE = process.env.SA6_API_BASE || 'http://localhost:3001/api';
const P1 = '+77009990001', P2 = '+77009990002', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
  if (!ok) fails++;
};

async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Ключ повтора (core/idempotency): ручки `required` (деньги, отправка, подпись)
      // без него отвечают 400. Свой на каждый вызов — сьюту нужны разные намерения.
      'Idempotency-Key': require('crypto').randomUUID(),
      // Язык ответов сьюты — ЯВНЫМ заголовком выбора: `Accept-Language` сервер
      // маршрутизирует под рынок (русский браузер → казахский), и русские ассерты
      // ниже покраснели бы разом. Скрипты про сам перевод шлют свои заголовки.
      'X-Locale': process.env.SA6_SUITE_LOCALE || 'ru',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}

const login = async (phone) => {
  const r = await call('POST', '/auth/login', null, { phone, password: PW });
  if (!r.ok) throw new Error(`login ${phone}: ${r.status} ${JSON.stringify(r.json)}`);
  const token = r.json.data.accessToken;
  const me = await call('GET', '/users/me', token);
  return { token, userId: me.json.data.id };
};

// ------------------------------------------------------------
// Генераторы валидных номеров (те же публичные алгоритмы, что в shared)
// ------------------------------------------------------------
function makeIinOrBin() {
  for (;;) {
    const d = Array.from({ length: 11 }, () => Math.floor(Math.random() * 10));
    const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    let s = d.reduce((a, x, i) => a + x * w1[i], 0) % 11;
    if (s === 10) {
      s = d.reduce((a, x, i) => a + x * w2[i], 0) % 11;
      if (s === 10) continue;
    }
    return d.join('') + String(s);
  }
}
function mod97(digits) {
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  return rem;
}
function makeKzIban() {
  const body = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
  const numeric = (body + 'KZ00').replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  const checkDigits = String(98 - mod97(numeric)).padStart(2, '0');
  return `KZ${checkDigits}${body}`;
}

// ------------------------------------------------------------
// Конструктор НАСТОЯЩЕГО .docx (валидные части и связи; заголовок опционален)
// ------------------------------------------------------------
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function buildDocx(bodyXml, headerXml) {
  const withHeader = headerXml !== undefined;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    (withHeader
      ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
      : '') +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    (withHeader
      ? '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
      : '') +
    '</Relationships>';
  const sectPr = withHeader
    ? '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/></w:sectPr>'
    : '<w:sectPr/>';
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${W_NS} ${R_NS}><w:body>${bodyXml}${sectPr}</w:body></w:document>`;
  const entries = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'word/_rels/document.xml.rels': strToU8(docRels),
    'word/document.xml': strToU8(documentXml),
  };
  if (withHeader) {
    entries['word/header1.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W_NS}>${headerXml}</w:hdr>`,
    );
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

const p = (inner) => `<w:p>${inner}</w:p>`;
const r = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

function unpack(base64) {
  const out = unzipSync(new Uint8Array(Buffer.from(base64, 'base64')));
  return {
    doc: strFromU8(out['word/document.xml']),
    header: out['word/header1.xml'] ? strFromU8(out['word/header1.xml']) : null,
  };
}
const textOf = (xml) => xml.replace(/<[^>]+>/g, '');

/** Разделитель разрядов — ПРАВИЛО РЕГИОНА (профиль КЗ), одно на экран и бумагу */
const GROUP = require('@superapp/i18n').REGION_PROFILE_KZ.groupSeparator;

async function devRender(token, docx, values, ctx) {
  return call('POST', '/templates/dev/render', token, {
    docxBase64: docx.toString('base64'),
    values,
    // Язык БУМАГИ (не запроса): «прописью», месяцы и «Да/Нет» собираются в нём.
    // Сьюта проверяет русский бланк, а отдельным блоком — казахский и английский.
    language: 'ru',
    ...(ctx || {}),
  });
}
async function devCompile(token, docx, extraPaths) {
  return call('POST', '/templates/dev/compile', token, {
    docxBase64: docx.toString('base64'),
    ...(extraPaths ? { extraPaths } : {}),
  });
}

async function main() {
  const { token: t1, userId: u1 } = await login(P1);
  const { token: t2, userId: u2 } = await login(P2);
  const stamp = Date.now();
  const cleanup = { wsId: null };

  try {
    // ============================================================
    // 1. Механика драйвера: подстановка, сборка разорванного тега, форматтеры
    // ============================================================
    console.log('\n— Драйвер: подстановка и форматтеры —');
    {
      const body =
        p(r('БИН: {Organization.Bin}')) +
        // Тег, разорванный Word'ом на три прогона (проверка орфографии + жирный кусок)
        p(
          '<w:proofErr w:type="spellStart"/><w:r><w:t>{Emplo</w:t></w:r>' +
            '<w:proofErr w:type="spellEnd"/><w:r><w:rPr><w:b/></w:rPr><w:t>yee.Full</w:t></w:r>' +
            '<w:r><w:t>Name}</w:t></w:r>',
        ) +
        p(r('Дата: {Date|date} / {Date|date:long}')) +
        p(r('Сумма: {Amount|words} ({Amount|number} тг)')) +
        p(r('Дней: {Days|words:number}')) +
        p(r('Адрес: {Address}')) +
        p(r('Спец: {Special}')) +
        p(r('Активен: {Active}'));
      const header = p(r('Шапка: {Organization.Name}'));
      const docx = buildDocx(body, header);
      const values = {
        Organization: { Bin: '123456789012', Name: 'ТОО «Тест»' },
        Employee: { FullName: 'Ахметов Аскар' },
        Date: '2026-09-01',
        Amount: 123456.78,
        Days: 5,
        Address: 'г. Алматы\nул. Абая, 1',
        Special: 'А&Б <В>',
        Active: true,
      };
      const res = await devRender(t1, docx, values);
      check('рендер прошёл', res.ok, JSON.stringify(res.json?.message ?? res.status));
      if (res.ok) {
        const { doc, header: hdr } = unpack(res.json.data.docxBase64);
        const text = textOf(doc);
        check('простой тег подставлен', text.includes('БИН: 123456789012'));
        check('РАЗОРВАННЫЙ на 3 прогона тег собран и подставлен', text.includes('Ахметов Аскар'));
        check('дата короткая — 01.09.2026 (не 31.08 — регрессия Carbone)', text.includes('01.09.2026'));
        check('дата длинная — 1 сентября 2026 г.', text.includes('1 сентября 2026 г.'));
        check(
          'сумма прописью',
          text.includes('Сто двадцать три тысячи четыреста пятьдесят шесть тенге 78 тиын'),
          text.slice(text.indexOf('Сумма:'), text.indexOf('Сумма:') + 90),
        );
        // Разряды и дробь — ПРАВИЛА РЕГИОНА (узкий неразрывный пробел), а не
        // язык: печатать сумму своим пробелом значило бы разойтись с экраном
        check('число с разрядами по правилам региона', text.includes(`123${GROUP}456,78 тг`), text.slice(text.indexOf('('), text.indexOf('(') + 30));
        check('число словами', text.includes('Дней: пять'));
        check('многострочное значение — настоящий <w:br/>', doc.includes('<w:br/>') && text.includes('ул. Абая, 1'));
        check('спецсимволы экранированы', doc.includes('А&amp;Б &lt;В&gt;'));
        check('булево — словом', text.includes('Активен: Да'));
        check('в результате не осталось «{»', !text.includes('{') && !text.includes('}'));
        check('слово undefined в документе невозможно', !text.includes('undefined'));
        check('тег в КОЛОНТИТУЛЕ подставлен', hdr && textOf(hdr).includes('Шапка: ТОО «Тест»'));
        check('replaced сосчитан (10 в теле + 1 в шапке)', res.json.data.replaced === 11, String(res.json.data.replaced));
      }
    }

    // ============================================================
    // 2. Повтор строки таблицы
    // ============================================================
    console.log('\n— Повтор строки таблицы —');
    const tableDocx = (rowCells) =>
      buildDocx(
        '<w:tbl><w:tblPr/><w:tblGrid/>' +
          '<w:tr><w:tc>' + p(r('№')) + '</w:tc><w:tc>' + p(r('Название')) + '</w:tc><w:tc>' + p(r('Сумма')) + '</w:tc></w:tr>' +
          '<w:tr>' + rowCells + '</w:tr>' +
          '</w:tbl>' +
          p(r('Итого: {Итого|number}')),
      );
    const repeatRow =
      '<w:tc>' + p(r('{#Строки}{No}')) + '</w:tc>' +
      '<w:tc>' + p(r('{Название}')) + '</w:tc>' +
      '<w:tc>' + p(r('{Сумма|number}{/Строки}')) + '</w:tc>';
    {
      const res = await devRender(t1, tableDocx(repeatRow), {
        Строки: [
          { Название: 'Стол', Сумма: 12000 },
          { Название: 'Стул', Сумма: 5500.5 },
          { Название: 'Шкаф', Сумма: 99000 },
        ],
        Итого: 116500.5,
      });
      check('рендер с повтором прошёл', res.ok, JSON.stringify(res.json?.message ?? res.status));
      if (res.ok) {
        const { doc } = unpack(res.json.data.docxBase64);
        const text = textOf(doc);
        const trCount = (doc.match(/<w:tr[\s>]/g) || []).length;
        check('строка размножена: шапка + 3 клона', trCount === 4, `tr=${trCount}`);
        check('все элементы на месте и по порядку',
          text.indexOf('Стол') > 0 && text.indexOf('Стол') < text.indexOf('Стул') && text.indexOf('Стул') < text.indexOf('Шкаф'));
        check('{No} нумерует с единицы', text.includes('1') && /1\s*Стол|1Стол/.test(text.replace(/\s+/g, '')), text.slice(0, 60));
        check('форматтер работает В СТРОКЕ повтора', text.includes(`5${GROUP}500,5`));
        check('маркеры повтора удалены', !text.includes('{#') && !text.includes('{/'));
        check('поле ВНЕ повтора живо', text.includes(`Итого: 116${GROUP}500,5`));
      }

      const empty = await devRender(t1, tableDocx(repeatRow), { Строки: [], Итого: 0 });
      check('пустая коллекция — строка исчезла', empty.ok, JSON.stringify(empty.json?.message ?? empty.status));
      if (empty.ok) {
        const { doc } = unpack(empty.json.data.docxBase64);
        const trCount = (doc.match(/<w:tr[\s>]/g) || []).length;
        check('осталась только шапка таблицы', trCount === 1, `tr=${trCount}`);
        check('тегов не осталось', !textOf(doc).includes('{'));
      }

      const noCollection = await devRender(t1, tableDocx(repeatRow), { Итого: 0 });
      check('нет коллекции → громкий отказ со списком', noCollection.status === 400 &&
        noCollection.json?.details?.code === 'template_data' &&
        (noCollection.json?.details?.missing ?? []).includes('Строки'),
        JSON.stringify(noCollection.json?.details ?? noCollection.status));
    }

    // ============================================================
    // 3. Громкие отказы: компиляция и данные
    // ============================================================
    console.log('\n— Громкие отказы —');
    {
      const res = await devRender(t1, buildDocx(p(r('{Поле1} и {Поле2}'))), {});
      const missing = res.json?.details?.missing ?? [];
      check('нет данных → 400 со СПИСКОМ (оба поля за один заход)',
        res.status === 400 && res.json?.details?.code === 'template_data' &&
        missing.includes('Поле1') && missing.includes('Поле2'),
        JSON.stringify(missing));
    }
    {
      const res = await devRender(t1, buildDocx(p(r('до {Незакрытый тег без конца'))), {});
      check('незакрытый тег → template_compile',
        res.status === 400 && res.json?.details?.code === 'template_compile' &&
        (res.json?.details?.issues ?? []).some((i) => i.code === 'unclosed_tag'),
        JSON.stringify(res.json?.details?.issues ?? res.status));
    }
    {
      const res = await devCompile(t1, buildDocx(p(r('{Орг')) + p(r('анизация.БИН}'))));
      const issues = res.json?.data?.issues ?? [];
      check('тег через границу абзацев → tag_broken_by_break',
        issues.some((i) => i.code === 'tag_broken_by_break'), JSON.stringify(issues.map((i) => i.code)));
    }
    {
      const res = await devCompile(t1, buildDocx(p(r('хвост} без открытия'))));
      const issues = res.json?.data?.issues ?? [];
      check('«}» без пары → stray_close', issues.some((i) => i.code === 'stray_close'));
    }
    {
      const res = await devCompile(t1, buildDocx(p(r('{Поле|фигня}'))), ['Поле']);
      const issues = res.json?.data?.issues ?? [];
      check('неизвестный форматтер пойман', issues.some((i) => i.code === 'unknown_formatter'));
    }
    {
      const res = await devCompile(t1, buildDocx(p(r('{дата без аргумента: {Поле|date:кривая}'))), ['Поле']);
      const issues = res.json?.data?.issues ?? [];
      check('неизвестный АРГУМЕНТ форматтера пойман', issues.some((i) => i.code === 'unknown_formatter'));
    }
    {
      const res = await devCompile(t1, tableDocx('<w:tc>' + p(r('{#Строки}{Название}')) + '</w:tc>'), ['Строки']);
      const issues = res.json?.data?.issues ?? [];
      check('повтор без {/} → repeat_unclosed', issues.some((i) => i.code === 'repeat_unclosed'), JSON.stringify(issues.map((i) => i.code)));
    }
    {
      const res = await devCompile(t1, buildDocx(p(r('{#Строки}в обычном абзаце{/Строки}'))), ['Строки']);
      const issues = res.json?.data?.issues ?? [];
      check('повтор вне таблицы → repeat_outside_table', issues.some((i) => i.code === 'repeat_outside_table'));
    }
    {
      const res = await devCompile(
        t1,
        buildDocx('<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc>' + p(r('{#А}x{/Б}')) + '</w:tc></w:tr></w:tbl>'),
        ['А'],
      );
      const issues = res.json?.data?.issues ?? [];
      check('{/Б} против {#А} → несовпадение поймано', issues.some((i) => i.code === 'repeat_without_open'));
    }
    {
      // ЯЗЫК БУМАГИ: те же значения, другой язык — другие слова и другой порядок
      // частей даты. Правила региона (разделители, dd.mm.yyyy) при этом ОДНИ.
      const body = p(r('{Date|date} / {Date|date:long} / {Amount|words} / {Active}'));
      const values = { Date: '2026-09-01', Amount: 123456.78, Active: true };

      const kk = await devRender(t1, buildDocx(body), values, { language: 'kk' });
      const kkText = kk.ok ? textOf(unpack(kk.json.data.docxBase64).doc) : '';
      check('казахский бланк: дата короткая в правилах региона', kkText.includes('01.09.2026'), kkText);
      check('казахский бланк: месяц по-казахски', kkText.includes('қыркүйек'), kkText);
      check('казахский бланк: сумма прописью по-казахски', kkText.includes('теңге') && kkText.includes('мың'), kkText);
      check('казахский бланк: булево словом языка', kkText.includes('Иә'), kkText);

      const en = await devRender(t1, buildDocx(body), values, { language: 'en' });
      const enText = en.ok ? textOf(unpack(en.json.data.docxBase64).doc) : '';
      check('английский бланк: дата короткая в правилах региона', enText.includes('01.09.2026'), enText);
      check('английский бланк: месяц по-английски', enText.includes('September'), enText);
      check(
        'английский бланк: сумма прописью по-английски',
        enText.includes('tenge') && enText.includes('thousand'),
        enText,
      );
      check('английский бланк: булево словом языка', enText.includes('Yes'), enText);
    }
    {
      const res = await devCompile(t1, buildDocx(p(r('{Orgnization.Bin} и {Organization.Bn} и {Просто} и {No}'))));
      const issues = res.json?.data?.issues ?? [];
      const msgs = issues.map((i) => i.message).join(' | ');
      check('опечатка в ГРУППЕ поймана', issues.some((i) => i.code === 'unknown_field' && i.message.includes('Orgnization')), msgs);
      check('опечатка в ПОЛЕ поймана', issues.some((i) => i.code === 'unknown_field' && i.message.includes('Bn')));
      check('голое поле вне повтора поймано', issues.some((i) => i.code === 'unknown_field' && i.message.includes('Просто')));
      check('{No} вне повтора пойман', issues.some((i) => i.message.includes('{No}')));
    }
    {
      const res = await devRender(t1, Buffer.from('это вообще не zip'), {});
      check('не-docx → bad_structure',
        res.status === 400 && (res.json?.details?.issues ?? []).some((i) => i.code === 'bad_structure'),
        JSON.stringify(res.json?.details ?? res.status));
    }
    {
      // Внутри повтора голые поля элемента компилятор честно НЕ трогает
      const res = await devCompile(t1, tableDocx(repeatRow), ['Строки', 'Итого']);
      const issues = res.json?.data?.issues ?? [];
      const tags = res.json?.data?.tags ?? [];
      check('валидный шаблон компилируется без замечаний', issues.length === 0, JSON.stringify(issues.map((i) => i.code)));
      check('теги перечислены для панели', tags.some((t) => t.kind === 'repeat_open' && t.path === 'Строки') &&
        tags.some((t) => t.kind === 'field' && t.path === 'Итого' && t.formatters[0]?.key === 'number'));
    }

    // ============================================================
    // 4. Реестр полей и живой резолв (организация + сотрудник)
    // ============================================================
    console.log('\n— Реестр и живые реквизиты —');
    {
      const res = await call('GET', '/templates/field-groups', t1);
      const groups = res.json?.data?.groups ?? [];
      const org = groups.find((g) => g.tagPrefix === 'Organization');
      const emp = groups.find((g) => g.tagPrefix === 'Employee');
      check('группы «Организация» и «Сотрудник» зарегистрированы', !!org && !!emp, JSON.stringify(groups.map((g) => g.tagPrefix)));
      check('у «Организации» есть Bin и Iik', org && org.fields.some((f) => f.key === 'Bin') && org.fields.some((f) => f.key === 'Iik'));
      check('у «Сотрудника» есть Iin и Position', emp && emp.fields.some((f) => f.key === 'Iin') && emp.fields.some((f) => f.key === 'Position'));
      check(
        'подписи полей — СЛОВА в языке запроса, а не имена тегов',
        org && org.fields.every((f) => typeof f.label === 'string' && f.label.length > 0 && f.label !== f.key),
        JSON.stringify(org?.fields?.slice(0, 3)),
      );
    }

    const cws = await call('POST', '/workspaces', t1, { name: `tpl-ws-${stamp}` });
    check('организация создана', cws.ok, `status ${cws.status}`);
    const wsId = cws.json.data.id;
    cleanup.wsId = wsId;

    {
      // Контракт честности: реквизиты не заполнены → отказ, а не пустота в приказе
      const res = await devRender(t1, buildDocx(p(r('{Organization.Name} БИН {Organization.Bin}'))), {}, { workspaceId: wsId });
      check('незаполненный реквизит → отказ «Organization.Bin» (не пустота)',
        res.status === 400 && (res.json?.details?.missing ?? []).includes('Organization.Bin'),
        JSON.stringify(res.json?.details ?? res.status));
    }

    const bin = makeIinOrBin();
    const iban = makeKzIban();
    await call('PATCH', `/workspaces/${wsId}/requisites`, t1, {
      orgForm: 'too',
      legalName: `ТОО «Шаблон-${stamp}»`,
      bin,
      legalAddress: 'г. Алматы, ул. Абая, 1',
      kbe: '17',
      directorUserId: u1,
      signBasis: { kind: 'ustav' },
    });
    const acc = await call('POST', `/workspaces/${wsId}/requisites/accounts`, t1, {
      iban, bankName: 'Kaspi Bank', bik: 'CASPKZKA',
    });
    check('реквизиты и счёт сохранены', acc.ok, `status ${acc.status}`);

    {
      // Язык БУМАГИ — русский: юрформа печатается его словом («ТОО», не «LLP»)
      const res = await call('POST', '/templates/dev/resolve', t1, { workspaceId: wsId, language: 'ru' });
      const org = res.json?.data?.values?.['Organization'] ?? {};
      check('резолв: БИН из анкеты', org['Bin'] === bin, JSON.stringify(org['Bin']));
      check('резолв: юрформа ярлыком языка бумаги', org['OrgForm'] === 'ТОО', String(org['OrgForm']));
      check('резолв: ИИК основного счёта', org['Iik'] === iban);
      check('резолв: БИК', org['Bik'] === 'CASPKZKA');
      check('резолв: директор — ФИО', typeof org['Director'] === 'string' && org['Director'].length > 0, org['Director']);
      check('резолв: не-плательщик НДС = осознанно-пустое', org['VatCertificate'] === '');
      const orgKk = await call('POST', '/templates/dev/resolve', t1, { workspaceId: wsId, language: 'kk' });
      check(
        'резолв: юрформа в языке БУМАГИ, а не запроса',
        orgKk.json?.data?.values?.['Organization']?.['OrgForm'] === 'ЖШС',
        String(orgKk.json?.data?.values?.['Organization']?.['OrgForm']),
      );
    }

    // Сотрудник: нанять u2, дать должность в отделе и филиале, заполнить анкету
    await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P2 });
    const inc = await call('GET', '/workspaces/invitations/incoming', t2);
    const inv = (inc.json?.data ?? []).find((i) => i.workspaceId === wsId);
    check('приглашение доставлено', !!inv);
    if (inv) await call('POST', `/workspaces/invitations/${inv.id}/accept`, t2);

    const dep = await call('POST', `/workspaces/${wsId}/staff/departments`, t1, { name: `Отдел продаж ${stamp}` });
    const pos = await call('POST', `/workspaces/${wsId}/staff/positions`, t1, {
      name: `Менеджер ${stamp}`, departmentId: dep.json?.data?.id,
    });
    const br = await call('POST', `/workspaces/${wsId}/staff/branches`, t1, { name: `Филиал на Абая ${stamp}` });
    const asg = await call('POST', `/workspaces/${wsId}/staff/members/${u2}/assignments`, t1, {
      positionId: pos.json?.data?.id, branchId: br.json?.data?.id,
    });
    check('назначение создано', asg.ok, `status ${asg.status}`);

    const iin2 = makeIinOrBin();
    await call('PATCH', '/users/me', t2, {
      iin: iin2,
      residentialAddress: 'г. Алматы, мкр. Самал-2, д. 33',
      idDocNumber: '038112233',
      idDocIssuedBy: 'МВД РК',
      idDocIssuedAt: '2020-02-01',
    });

    {
      const res = await call('POST', '/templates/dev/resolve', t1, {
        workspaceId: wsId,
        subjectUserId: u2,
        language: 'ru',
      });
      const emp = res.json?.data?.values?.['Employee'] ?? {};
      check('резолв сотрудника: ИИН', emp['Iin'] === iin2, JSON.stringify(emp['Iin']));
      check('резолв сотрудника: должность', String(emp['Position'] ?? '').startsWith('Менеджер'), emp['Position']);
      check('резолв сотрудника: отдел через должность', String(emp['Department'] ?? '').startsWith('Отдел продаж'));
      check('резолв сотрудника: филиал', String(emp['Branch'] ?? '').startsWith('Филиал на Абая'));
      check('резолв сотрудника: удостоверение строкой', String(emp['IdDocument'] ?? '').includes('№ 038112233'), emp['IdDocument']);
    }

    let renderedForSmoke = null;
    {
      // Полный круг: заявление собирается из реестра + значений формы
      const body =
        p(r('В {Organization.LegalName}')) +
        p(r('от {Employee.FullName}, {Employee.Position}')) +
        p(r('Прошу предоставить отпуск с {From|date:long} на {Days|words:number} дней.')) +
        p(r('ИИН: {Employee.Iin}'));
      const res = await devRender(t1, buildDocx(body), { From: '2026-09-01', Days: 14 }, { workspaceId: wsId, subjectUserId: u2 });
      check('полный круг: рендер прошёл', res.ok, JSON.stringify(res.json?.details ?? res.json?.message ?? res.status));
      if (res.ok) {
        const text = textOf(unpack(res.json.data.docxBase64).doc);
        check('заявление: юрнаименование', text.includes(`ТОО «Шаблон-${stamp}»`));
        check('заявление: должность из назначения', text.includes('Менеджер'));
        check('заявление: дата и срок словами', text.includes('1 сентября 2026 г.') && text.includes('четырнадцать дней'));
        check('заявление: ИИН сотрудника', text.includes(iin2));
        renderedForSmoke = Buffer.from(res.json.data.docxBase64, 'base64');
      }
    }

    // ============================================================
    // 5. Смоук настоящим Word-движком: наша сборка Collabora конвертирует
    //    РЕЗУЛЬТАТ РЕНДЕРА в PDF — битый файл она бы отвергла. SKIP без
    //    контейнера docs (паттерн verify-voice при выключенном STT).
    // ============================================================
    const docsStatus = await call('GET', '/docs/status', t1);
    if (!docsStatus.json?.data?.enabled || !renderedForSmoke) {
      console.log('\n— Смоук Collabora: SKIP (DOCS_EDITOR_URL не задан) —');
    } else {
      console.log('\n— Смоук: рендер открывается настоящим Word-движком —');
      const DOCX_MIME_STR = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const init = await call('POST', '/files', t1, {
        profile: 'document', name: `tpl-smoke-${stamp}.docx`, mime: DOCX_MIME_STR, size: renderedForSmoke.length,
      });
      check('файл-инициализация', init.ok, `status ${init.status}`);
      const fileId = init.json?.data?.file?.id;
      if (fileId) {
        cleanup.fileId = fileId;
        const fd = new FormData();
        fd.append('file', new Blob([renderedForSmoke], { type: DOCX_MIME_STR }), `tpl-smoke-${stamp}.docx`);
        const put = await fetch(`${BASE}/files/${fileId}/content`, {
          method: 'PUT', headers: { Authorization: 'Bearer ' + t1 }, body: fd,
        });
        const done = await call('POST', `/files/${fileId}/complete`, t1, {});
        check('байты загружены', put.ok && done.ok, `put ${put.status} complete ${done.status}`);

        const doc = await call('POST', '/docs/from-file', t1, { fileId, title: `Смоук ${stamp}` });
        check('файл ожил в документ', doc.ok, JSON.stringify(doc.json?.message ?? doc.status));
        const docId = doc.json?.data?.id;
        if (docId) {
          cleanup.docId = docId;
          let ready = false;
          for (let i = 0; i < 30 && !ready; i++) {
            const rend = await call('POST', `/docs/${docId}/rendition`, t1, { target: 'pdf' });
            ready = rend.json?.data?.ready === true;
            if (!ready) await new Promise((res2) => setTimeout(res2, 3000));
          }
          check('Collabora конвертировала наш рендер в PDF (файл валиден)', ready);
        }
      }
    }
  } finally {
    // Уборка: только свои объекты, штатным путём
    if (cleanup.docId) await call('DELETE', `/docs/${cleanup.docId}`, t1);
    if (cleanup.fileId) await call('DELETE', `/files/${cleanup.fileId}`, t1);
    if (cleanup.wsId) await call('DELETE', `/workspaces/${cleanup.wsId}`, t1);
    await call('PATCH', '/users/me', t2, {
      iin: null, residentialAddress: null, idDocNumber: null, idDocIssuedBy: null, idDocIssuedAt: null,
    });
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : `FAILS: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
