// ============================================================
// E2E: core/visibility (27-й движок) — «кто видит КАКИЕ поля и в каком виде».
//
// Канарейки: в защищённые поля трёх субъектов кладутся уникальные строки/числа прогона, затем
// зрители разных уровней обходят поверхности (карточки, ростер, карточка сотрудника, КЭДО,
// хроника, контрагенты, штатка, анкета организации, предпросмотры, объяснение) — в СЫРОМ JSON
// ответа канарейка обязана отсутствовать у тех, кому поле скрыто или маскировано.
// Плюс: раскрытие одной записи (step-up, журнал), W (правка скрытого → 403, маска в теле → 400),
// публикация политики (кэш сброшен со следующего запроса), находимость (nobody ≡ «не найден»),
// ключи API без флага «контакты» не видят контактов.
//
// Аккаунты СЬЮТА (suite1 — владелец, suite2 — сотрудник-субъект, suite3 — коллега/менеджер);
// организация прогона одноразовая (createSuiteWorkspace), БД сьют не чистит.
// Run: node apps/api/scripts/verify-visibility.cjs   (API запущен)
// ============================================================
const { call, login, makeChecker, SUITE, devCode, createSuiteWorkspace, crash } = require('./_lib.cjs');

const { check, finish } = makeChecker();

/**
 * Манифест: КАЖДЫЙ тип реестра видимости обязан иметь здесь сценарий (страж `check:visibility`
 * сверяет строку манифеста с реестром shared — новый тип без канарейки валит проверку).
 */
const CANARY_TYPES = [
  'user.card',
  'workspace.card',
  'staff.member',
  'hr.employment',
  'objects.staffing',
  'objects.shift',
  'counterparty',
];

const RUN = `cn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const raw = (r) => JSON.stringify(r?.json ?? null);
const hid = (v) => v && typeof v === 'object' && v.$v === 'hidden';
const masked = (v) => v && typeof v === 'object' && v.$v === 'masked';

function makeIin() {
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

async function hire(wsId, owner, person) {
  const inv = (await call('POST', `/workspaces/${wsId}/invitations`, owner.token, { phone: person.phone })).json?.data;
  const mine = (await call('GET', '/workspaces/invitations/incoming', person.token)).json?.data?.find?.((i) => i.workspaceId === wsId);
  return call('POST', `/workspaces/invitations/${mine?.id ?? inv?.id}/accept`, person.token);
}

/** Окно сильного подтверждения цели (пароль + SMS-код из дев-ручки). */
async function stepUp(s, purpose) {
  const st = await call('POST', '/verify/step-up', s.token, { purpose, password: SUITE.password });
  if (!st.ok) return st;
  const code = await devCode(st.json.data.challengeId);
  const chk = await call('POST', '/verify/check', null, { challengeId: st.json.data.challengeId, code });
  if (!chk.ok) return chk;
  return call('POST', '/verify/step-up/confirm', s.token, { purpose, verifyToken: chk.json.data.verifyToken });
}

async function main() {
  const O = { ...(await login(SUITE.p1)), phone: SUITE.p1 }; // владелец
  const S = { ...(await login(SUITE.p2)), phone: SUITE.p2 }; // субъект (стажёр)
  const M = { ...(await login(SUITE.p3)), phone: SUITE.p3 }; // коллега → менеджер
  const personalReset = [];

  const ws = (await createSuiteWorkspace(O.token, 'Сьют-Видимость')).json?.data;
  check('организация прогона создана', !!ws?.id);
  const W = ws.id;
  const WS = { 'X-Workspace-Id': W };
  await hire(W, O, S);
  await hire(W, O, M);
  const toMgr = await call('PATCH', `/workspaces/${W}/members/${M.id}`, O.token, { role: 'manager' });
  check('коллега стал менеджером', toMgr.ok, `${toMgr.status}`);

  try {
    // ======================================================================
    // user.card — личные правила человека
    // ======================================================================
    const CITY = `${RUN}-city`;
    const BIO = `${RUN}-bio`;
    await call('PATCH', '/users/me', S.token, { city: CITY, bio: BIO });
    const put = await call('PUT', '/visibility/me', S.token, {
      fields: [
        { fieldKey: 'city', audiences: [] }, // никому
        { fieldKey: 'bio', audiences: [{ kind: 'colleagues', id: null }] }, // коллегам
      ],
    });
    personalReset.push('city', 'bio');
    check('user.card: правила карточки приняты', put.ok, `${put.status} ${put.code}`);
    const roster = await call('GET', `/workspaces/${W}/members`, M.token);
    const sRow = (roster.json?.data ?? []).find((m) => m.userId === S.id);
    check('user.card: коллега видит «О себе» (правило человека)', sRow?.card?.bio === BIO, JSON.stringify(sRow?.card?.bio));
    check('user.card: город «никому» — маркер скрытия, канарейки в ответе нет', hid(sRow?.card?.city) && !raw(roster).includes(CITY));
    const prevStranger = await call('GET', '/users/me/card-preview?as=stranger', S.token);
    check('user.card: предпросмотр «чужой» без города и био', prevStranger.ok && !raw(prevStranger).includes(CITY) && !raw(prevStranger).includes(BIO), raw(prevStranger).slice(0, 160));
    const prevColleague = await call('GET', `/users/me/card-preview?as=colleague&id=${W}`, S.token);
    check('user.card: предпросмотр «коллега» совпадает с ростером (био видно, город нет)', prevColleague.json?.data?.bio === BIO && hid(prevColleague.json?.data?.city));
    const selfProfile = await call('GET', '/users/me', S.token);
    check('user.card: сам видит своё полностью', selfProfile.json?.data?.city === CITY);

    // Находимость: «никто» неотличим от «не найден»
    await call('PUT', '/visibility/me/discoverability', S.token, { discoverableBy: 'nobody' });
    const lkHidden = await call('GET', `/users/lookup?phone=${encodeURIComponent(S.phone)}`, M.token);
    const lkMissing = await call('GET', `/users/lookup?phone=${encodeURIComponent('+77009999998')}`, M.token);
    check('находимость: «никто» ≡ «не найден» (статус и код)', lkHidden.status === lkMissing.status && lkHidden.code === lkMissing.code, `${lkHidden.status}/${lkHidden.code} vs ${lkMissing.status}/${lkMissing.code}`);
    await call('PUT', '/visibility/me/discoverability', S.token, { discoverableBy: 'everybody' });

    // Исключения конкретному человеку: «Никогда» сильнее аудитории «коллеги», «Всегда» — сильнее «никому»;
    // один человек и в «Всегда», и в «Никогда» — отказ на вводе
    const exc = await call('PUT', '/visibility/me', S.token, {
      fields: [
        { fieldKey: 'bio', audiences: [{ kind: 'colleagues', id: null }], never: [M.id] },
        { fieldKey: 'city', audiences: [], always: [M.id] },
      ],
    });
    check('user.card: исключения приняты', exc.ok, `${exc.status} ${exc.code}`);
    const rosterExc = await call('GET', `/workspaces/${W}/members`, M.token);
    const sExc = (rosterExc.json?.data ?? []).find((m) => m.userId === S.id);
    check('user.card: «Никогда» сильнее аудитории «коллеги» — «О себе» скрыто', hid(sExc?.card?.bio) && !raw(rosterExc).includes(BIO), JSON.stringify(sExc?.card?.bio));
    check('user.card: «Всегда» сильнее «никому» — город виден этому человеку', sExc?.card?.city === CITY, JSON.stringify(sExc?.card?.city));
    const rosterOwner = await call('GET', `/workspaces/${W}/members`, O.token);
    check('user.card: «Всегда» одному не открывает поле остальным', !raw(rosterOwner).includes(CITY));
    const conflict = await call('PUT', '/visibility/me', S.token, { fields: [{ fieldKey: 'bio', audiences: [], always: [M.id], never: [M.id] }] });
    check('user.card: один человек и во «Всегда», и в «Никогда» → 400', conflict.status === 400, `${conflict.status} ${conflict.code}`);
    // Вернуть правила сценария (город — никому, «О себе» — коллегам): дальше M — «чужой» зритель города
    await call('PUT', '/visibility/me', S.token, {
      fields: [
        { fieldKey: 'city', audiences: [] },
        { fieldKey: 'bio', audiences: [{ kind: 'colleagues', id: null }] },
      ],
    });

    // ======================================================================
    // staff.member — служебные поля: владелец — маска + раскрытие, менеджер — скрыто, сам — всё
    // ======================================================================
    const IIN = makeIin();
    // Своя канарейка адреса: RUN сидит и в «О себе», которое коллегам видно законно
    const ADDR_CANARY = `${RUN}addr`;
    const ADDR = `г. Алматы, ул. ${ADDR_CANARY}, 1`;
    await call('PATCH', '/users/me', S.token, { iin: IIN, residentialAddress: ADDR });
    const asOwner = await call('GET', `/workspaces/${W}/members/${S.id}`, O.token);
    const rq = asOwner.json?.data?.requisites ?? {};
    check('staff.member: владельцу ИИН — маска с раскрытием', masked(rq.iin) && rq.iin.reveal === 'one', JSON.stringify(rq.iin));
    check('staff.member: владельцу адрес — только город', masked(rq.residentialAddress) && !raw(asOwner).includes(ADDR_CANARY));
    check('staff.member: полного ИИН в ответе владельцу нет', !raw(asOwner).includes(IIN));
    const asMgr = await call('GET', `/workspaces/${W}/members/${S.id}`, M.token);
    check('staff.member: менеджеру реквизиты скрыты (маркер + счётчик)', hid(asMgr.json?.data?.requisites?.iin) && (asMgr.json?.data?.requisites?.hiddenCount ?? 0) > 0);
    check('staff.member: канареек нет в ответе менеджеру', !raw(asMgr).includes(IIN) && !raw(asMgr).includes(ADDR_CANARY));
    const asSelf = await call('GET', `/workspaces/${W}/members/${S.id}`, S.token);
    check('staff.member: сам видит свои реквизиты полностью (ЗоПД ст. 24)', asSelf.json?.data?.requisites?.iin === IIN);

    // Раскрытие ОДНОЙ записи: без окна — 403 с кодом; с окном — значение и событие у субъекта
    const rev0 = await call('POST', '/visibility/reveal', O.token, { recordType: 'staff.member', recordId: S.id, fields: ['iin'] }, WS);
    check('раскрытие без окна подтверждения → 403 visibility.step_up_required', rev0.status === 403 && rev0.code === 'visibility.step_up_required', `${rev0.status} ${rev0.code}`);
    const su = await stepUp(O, 'visibility_reveal');
    check('окно подтверждения visibility_reveal открыто', su.ok, `${su.status} ${su.code}`);
    const rev1 = await call('POST', '/visibility/reveal', O.token, { recordType: 'staff.member', recordId: S.id, fields: ['iin'] }, WS);
    check('раскрытие с окном → значение одной записи', rev1.ok && rev1.json?.data?.values?.iin === IIN && !!rev1.json?.data?.showUntil, `${rev1.status} ${rev1.code}`);
    const revMgr = await call('POST', '/visibility/reveal', M.token, { recordType: 'staff.member', recordId: S.id, fields: ['iin'] }, WS);
    check('менеджеру раскрытие не положено → 403', revMgr.status === 403, `${revMgr.status} ${revMgr.code}`);
    const revPan = await call('POST', '/visibility/reveal', O.token, { recordType: 'staff.member', recordId: S.id, fields: ['paymentCardPan'] }, WS);
    check('полный номер карты не раскрывается никому (секрет)', revPan.status === 403 || revPan.status === 404, `${revPan.status} ${revPan.code}`);
    const feed = await call('GET', '/users/me/security/events?filter=reveals', S.token);
    const feedItems = feed.json?.data?.items ?? [];
    check('субъект видит раскрытие в своей ленте (pii.reveal)', feed.ok && feedItems.some((e) => e.key === 'pii.reveal'), `${feed.status} ${feedItems.map((e) => e.key).join(',')}`);
    await call('POST', '/verify/step-up/end', O.token, { purpose: 'visibility_reveal' });

    // ======================================================================
    // hr.employment — оклад: владелец и сам; менеджер (не руководитель субъекта) — скрыто
    // ======================================================================
    const SALARY = 30000000 + Math.floor(Math.random() * 900000) * 10; // уникальные тиыны
    const emp = await call('PUT', `/workspaces/${W}/hr/members/${S.id}/employment`, O.token, { hiredAt: '2026-01-15', salaryAmount: SALARY });
    check('hr.employment: карточка заведена владельцем', emp.ok && emp.json?.data?.salaryAmount === String(SALARY), `${emp.status} ${emp.code}`);
    const hrMgr = await call('GET', `/workspaces/${W}/hr/members/${S.id}`, M.token);
    check('hr.employment: менеджеру оклад скрыт, суммы в ответе нет', hid(hrMgr.json?.data?.employment?.salaryAmount) && !raw(hrMgr).includes(String(SALARY)), JSON.stringify(hrMgr.json?.data?.employment?.salaryAmount));
    const hrSelf = await call('GET', `/workspaces/${W}/hr/members/${S.id}`, S.token);
    check('hr.employment: сам видит свой оклад (ТК ст. 113)', hrSelf.json?.data?.employment?.salaryAmount === String(SALARY));
    const wMgr = await call('PUT', `/workspaces/${W}/hr/members/${S.id}/employment`, M.token, { salaryAmount: SALARY + 10 });
    check('W: менеджер не правит оклад, которого не видит → 403 visibility.field_forbidden', wMgr.status === 403 && wMgr.code === 'visibility.field_forbidden', `${wMgr.status} ${wMgr.code}`);
    // Хроника: смена оклада — «было → стало» скрыто менеджеру
    await call('PUT', `/workspaces/${W}/hr/members/${S.id}/employment`, O.token, { salaryAmount: SALARY + 1000 });
    const chron = await call('GET', `/chatter/hr_member/${encodeURIComponent(`${W}:${S.id}`)}`, M.token);
    check('хроника: менеджер не видит сумм оклада в «было → стало»', chron.ok && !raw(chron).includes(String(SALARY)) && !raw(chron).includes(String(SALARY + 1000)), `${chron.status}`);
    const chronOwner = await call('GET', `/chatter/hr_member/${encodeURIComponent(`${W}:${S.id}`)}`, O.token);
    check('хроника: владелец видит изменение оклада', raw(chronOwner).includes(String(SALARY + 1000)));

    // ======================================================================
    // counterparty — контакты: стажёру маской, менеджеру+ полностью
    // ======================================================================
    const cpPhone = `+7 701 ${String(Math.floor(1000000 + Math.random() * 8999999)).replace(/(\d{3})(\d{2})(\d{2})/, '$1 $2 $3')}`;
    const cpDigits = cpPhone.replace(/\D/g, '');
    const cp = await call('POST', `/workspaces/${W}/counterparties`, O.token, { kind: 'legal', name: `Канарейка ${RUN}`, phone: cpPhone, email: `${RUN}@example.kz` });
    check('counterparty: контрагент создан', cp.ok, `${cp.status} ${cp.code}`);
    const cpId = cp.json?.data?.id;
    const cpTrainee = await call('GET', `/workspaces/${W}/counterparties/${cpId}`, S.token);
    check('counterparty: стажёру телефон — маской', masked(cpTrainee.json?.data?.phone) && !raw(cpTrainee).includes(cpDigits), JSON.stringify(cpTrainee.json?.data?.phone));
    check('counterparty: стажёру e-mail — маской', masked(cpTrainee.json?.data?.email) && !raw(cpTrainee).includes(`${RUN}@`));
    const cpList = await call('GET', `/workspaces/${W}/counterparties?limit=50`, S.token);
    check('counterparty: в СПИСКЕ стажёру тоже маска', !raw(cpList).includes(cpDigits));
    const cpMgr = await call('GET', `/workspaces/${W}/counterparties/${cpId}`, M.token);
    check('counterparty: менеджеру телефон полностью', cpMgr.json?.data?.phone === `+${cpDigits}`, JSON.stringify(cpMgr.json?.data?.phone));
    // Политика организации: скрыть телефон от стажёров — действует со следующего запроса
    const pol = `/workspaces/${W}/visibility/policies/counterparty`;
    await call('PUT', `${pol}/draft`, O.token, { rules: [{ fieldKey: 'phone', audience: { kind: 'role', id: 'trainee' }, effect: 'deny', level: 'hidden' }] });
    const diff = await call('GET', `${pol}/diff`, O.token);
    const pub = await call('POST', `${pol}/publish`, O.token, { draftToken: diff.json?.data?.draftToken });
    check('политика: публикация правила', pub.ok && pub.json?.data?.status === 'published', `${pub.status} ${pub.code}`);
    const cpTrainee2 = await call('GET', `/workspaces/${W}/counterparties/${cpId}`, S.token);
    check('политика: кэш сброшен — телефон стажёру скрыт сразу', hid(cpTrainee2.json?.data?.phone), JSON.stringify(cpTrainee2.json?.data?.phone));
    const wMask = await call('PATCH', `/workspaces/${W}/counterparties/${cpId}`, O.token, { phone: '+7 70* *** *5 67' });
    check('W: маска в теле правки → 400', wMask.status === 400, `${wMask.status} ${wMask.code}`);
    // Хроника контрагента: смена телефона — стажёру скрыта
    await call('PATCH', `/workspaces/${W}/counterparties/${cpId}`, O.token, { phone: '+7 702 111 22 33' });
    const cpChron = await call('GET', `/chatter/counterparty/${cpId}`, S.token);
    check('хроника контрагента: стажёр не видит номеров', cpChron.ok && !raw(cpChron).includes(cpDigits) && !raw(cpChron).includes('77021112233'), `${cpChron.status}`);

    // Смена роли действует со следующего запроса — и когда ребро доступа НЕ меняется (Сотрудник ↔
    // Стажёр — одно и то же `member`, эпоха прав не бампается): роль читается свежей, а не из кэша фактов
    await call('PATCH', `/workspaces/${W}/members/${M.id}`, O.token, { role: 'staff' });
    const cpAsStaff = await call('GET', `/workspaces/${W}/counterparties/${cpId}`, M.token);
    check('роль: Менеджер → Сотрудник — телефон контрагента сразу маской', masked(cpAsStaff.json?.data?.phone), JSON.stringify(cpAsStaff.json?.data?.phone));
    await call('PATCH', `/workspaces/${W}/members/${M.id}`, O.token, { role: 'trainee' });
    const cpAsTrainee = await call('GET', `/workspaces/${W}/counterparties/${cpId}`, M.token);
    check('роль: Сотрудник → Стажёр — запрет стажёрам действует сразу (роль не живёт в кэше)', hid(cpAsTrainee.json?.data?.phone), JSON.stringify(cpAsTrainee.json?.data?.phone));
    const backToMgr = await call('PATCH', `/workspaces/${W}/members/${M.id}`, O.token, { role: 'manager' });
    check('роль: коллега снова менеджер', backToMgr.ok, `${backToMgr.status}`);

    // Адресат «ведёт график объекта» — в реестре, в Zod и в CHECK таблицы правил (23514 → 500 иначе)
    const polSh = `/workspaces/${W}/visibility/policies/objects.shift`;
    const schedRule = await call('PUT', `${polSh}/draft`, O.token, { rules: [{ fieldKey: 'attendanceNote', audience: { kind: 'branch_scheduler', id: null }, effect: 'allow', level: 'full' }] });
    check('политика: правило адресату branch_scheduler сохраняется', schedRule.ok && schedRule.json?.data?.rules?.[0]?.audience?.kind === 'branch_scheduler', `${schedRule.status} ${schedRule.code}`);
    await call('DELETE', `${polSh}/draft`, O.token);

    // «Проверить сотрудника» — только служебные типы: объяснение личной карточки выдало бы
    // организации личный граф двух людей (связь в Окружении, Группы)
    const exPersonal = await call('GET', `/workspaces/${W}/visibility/explain?recordType=user.card&viewerId=${M.id}&subjectId=${S.id}`, O.token);
    check('explain: личная карточка не объясняется организации → 400 visibility.unknown_record_type', exPersonal.status === 400 && exPersonal.code === 'visibility.unknown_record_type', `${exPersonal.status} ${exPersonal.code}`);

    // Детекция скрейпинга (dev-полигон считает чужие строки без 20 000 живых записей):
    // тревога ровно при пересечении порога, один раз на окно, в журнале организации
    await call('POST', '/visibility/dev/scrape-reset', M.token, {});
    const sp1 = await call('POST', '/visibility/dev/scrape-probe', M.token, { rows: 19_999 }, WS);
    const sp2 = await call('POST', '/visibility/dev/scrape-probe', M.token, { rows: 2 }, WS);
    const sp3 = await call('POST', '/visibility/dev/scrape-probe', M.token, { rows: 5 }, WS);
    check(
      'детекция скрейпинга: тревога при пересечении порога и только один раз на окно',
      sp1.ok && sp1.json?.data?.fired === false && sp2.ok && sp2.json?.data?.fired === true && sp3.ok && sp3.json?.data?.fired === false,
      `${sp1.status}/${JSON.stringify(sp1.json?.data)} ${sp2.status}/${JSON.stringify(sp2.json?.data)} ${sp3.status}/${JSON.stringify(sp3.json?.data)}`,
    );
    const orgFeed = await call('GET', `/workspaces/${W}/security/events?filter=reveals`, O.token);
    const orgItems = orgFeed.json?.data?.items ?? [];
    check('детекция скрейпинга: detect.pii_scrape в журнале организации', orgFeed.ok && orgItems.some((e) => e.key === 'detect.pii_scrape'), `${orgFeed.status} ${orgItems.map((e) => e.key).join(',')}`);
    await call('POST', '/visibility/dev/scrape-reset', M.token, {});

    // Дифференциал: стажёр (телефон скрыт) и менеджер (целиком) получают те же записи в том же
    // порядке; поиск по цифрам скрытого телефона запись не находит — поиск идёт только по полу
    const idsOf = (r) => {
      const d = r.json?.data;
      return (Array.isArray(d) ? d : (d?.items ?? [])).map((x) => x.id);
    };
    const cpListS = await call('GET', `/workspaces/${W}/counterparties?limit=50`, S.token);
    const cpListM = await call('GET', `/workspaces/${W}/counterparties?limit=50`, M.token);
    check('дифференциал: стажёр и менеджер видят те же записи в том же порядке', idsOf(cpListS).length > 0 && JSON.stringify(idsOf(cpListS)) === JSON.stringify(idsOf(cpListM)));
    const oracle = await call('GET', `/workspaces/${W}/counterparties?limit=50&search=1112233`, S.token);
    check('Q: поиск по цифрам скрытого телефона не находит запись (не оракул)', oracle.ok && !idsOf(oracle).includes(cpId), `${oracle.status}`);
    const gs = await call('GET', `/search?q=${encodeURIComponent(`Канарейка ${RUN}`)}`, S.token, undefined, WS);
    check('глобальный поиск: стажёру номер контрагента не приходит', gs.ok && !raw(gs).includes('1112233') && !raw(gs).includes(cpDigits), `${gs.status}`);
    const rc = await call('GET', `/rich-cards/counterparty/${cpId}`, S.token, undefined, WS);
    check('рич-карта контрагента: стажёру номера нет', (rc.ok || rc.status === 404) && !raw(rc).includes('1112233'), `${rc.status}`);

    // Ослабление строгого поля (ИИН менеджеру целиком) — только в окне SMS-подтверждения
    const polSm = `/workspaces/${W}/visibility/policies/staff.member`;
    await call('PUT', `${polSm}/draft`, O.token, { rules: [{ fieldKey: 'iin', audience: { kind: 'role', id: 'manager' }, effect: 'allow', level: 'full' }] });
    const diffSm = await call('GET', `${polSm}/diff`, O.token);
    const pubSm = await call('POST', `${polSm}/publish`, O.token, { draftToken: diffSm.json?.data?.draftToken });
    check('политика: ослабление строгого поля без окна SMS → 403 visibility.step_up_required', pubSm.status === 403 && pubSm.code === 'visibility.step_up_required', `${pubSm.status} ${pubSm.code}`);
    await call('DELETE', `${polSm}/draft`, O.token);
    // Запрет организации на оклад стажёрам не скрывает оклад от самого стажёра (ТК ст. 113)
    const polHr = `/workspaces/${W}/visibility/policies/hr.employment`;
    await call('PUT', `${polHr}/draft`, O.token, { rules: [{ fieldKey: 'salaryAmount', audience: { kind: 'role', id: 'trainee' }, effect: 'deny', level: 'hidden' }] });
    const diffHr = await call('GET', `${polHr}/diff`, O.token);
    const pubHr = await call('POST', `${polHr}/publish`, O.token, { draftToken: diffHr.json?.data?.draftToken });
    check('политика: запрет окладов стажёрам опубликован', pubHr.ok, `${pubHr.status} ${pubHr.code}`);
    const hrSelf2 = await call('GET', `/workspaces/${W}/hr/members/${S.id}`, S.token);
    check('«сам» сильнее запрета организации: стажёр видит свой оклад', hrSelf2.json?.data?.employment?.salaryAmount === String(SALARY + 1000), JSON.stringify(hrSelf2.json?.data?.employment?.salaryAmount));

    // ======================================================================
    // workspace.card — контакты организации: сотрудникам телефон скрыт, владельцу виден
    // ======================================================================
    const WPHONE = `+7 777 ${String(Math.floor(100 + Math.random() * 899))} ${String(Math.floor(10 + Math.random() * 89))} ${String(Math.floor(10 + Math.random() * 89))}`;
    const wDigits = WPHONE.replace(/\D/g, '');
    await call('PATCH', `/workspaces/${W}`, O.token, { contactPhone: WPHONE });
    const wsStaff = await call('GET', `/workspaces/${W}`, S.token);
    check('workspace.card: сотруднику телефон организации скрыт', hid(wsStaff.json?.data?.contactPhone) && !raw(wsStaff).includes(wDigits));
    const wsPrev = await call('GET', `/workspaces/${W}/card-preview?role=staff`, O.token);
    check('workspace.card: предпросмотр «как видит сотрудник» совпадает с фактом', hid(wsPrev.json?.data?.contactPhone), JSON.stringify(wsPrev.json?.data?.contactPhone));
    const wsPrevStaff = await call('GET', `/workspaces/${W}/card-preview?role=staff`, S.token);
    check('workspace.card: предпросмотр политики — только владельцу/админу', wsPrevStaff.status === 403, `${wsPrevStaff.status}`);

    // ======================================================================
    // objects.staffing / objects.shift — деньги объекта и факт выходов
    // ======================================================================
    const objBase = `/workspaces/${W}/objects`;
    const site = (await call('POST', objBase, O.token, { name: `Точка ${RUN}`, kind: 'site' })).json?.data;
    const posRes = (await call('POST', `/workspaces/${W}/staff/positions`, O.token, { name: `Бариста ${RUN}` })).json?.data;
    const PLANNED = String(40000000 + Math.floor(Math.random() * 900000) * 10);
    await call('POST', `${objBase}/${site.id}/staffing/positions`, O.token, { positionId: posRes.id, headcount: 2, plannedRate: { rateType: 'monthly', amount: PLANNED } });
    const ACTUAL = String(35000000 + Math.floor(Math.random() * 900000) * 10);
    const period = new Date().toISOString().slice(0, 7);
    const t0 = await call('GET', `${objBase}/${site.id}/staffing?period=${period}`, O.token);
    const spId = (t0.json?.data?.rows ?? []).find((r) => r.positionId === posRes.id)?.staffingPositionId;
    const asg = await call('POST', `${objBase}/${site.id}/staffing/assign`, O.token, { userId: S.id, staffingPositionId: spId, rate: { rateType: 'monthly', amount: ACTUAL } });
    check('objects.staffing: сотрудник назначен со ставкой', asg.ok, `${asg.status} ${asg.code}`);
    const tSelf = await call('GET', `${objBase}/${site.id}/staffing?period=${period}`, S.token);
    const ownRow = (tSelf.json?.data?.rows ?? []).find((r) => r.assignment?.userId === S.id);
    check('objects.staffing: сам видит свою ставку', ownRow?.actualRate?.amount === ACTUAL, JSON.stringify(ownRow?.actualRate));
    check('objects.staffing: плановую ставку (бюджет) сам не видит, итогов нет', !raw(tSelf).includes(PLANNED) && !tSelf.json?.data?.totals);
    const tOwner = await call('GET', `${objBase}/${site.id}/staffing?period=${period}`, O.token);
    check('objects.staffing: владелец видит план и итоги', raw(tOwner).includes(PLANNED) && !!tOwner.json?.data?.totals);
    // Смены: заметка к смене видна всем, кто видит опубликованную смену; факт — планировщикам и самому
    const board = await call('GET', `/workspaces/${W}/objects/${site.id}/shifts?from=${period}-01&to=${period}-28`, S.token);
    check('objects.shift: сетка смен доступна сотруднику объекта', board.ok || board.status === 404, `${board.status}`);

    // ======================================================================
    // «Проверить сотрудника» совпадает с фактом (если тариф открывает)
    // ======================================================================
    const ex = await call('GET', `/workspaces/${W}/visibility/explain?recordType=staff.member&viewerId=${M.id}&subjectId=${S.id}`, O.token);
    if (ex.status === 402) {
      check('explain: за замком тарифа → 402 entitlement.*', /^entitlement\./.test(ex.code ?? ''), ex.code);
    } else {
      const iinRow = (ex.json?.data?.fields ?? []).find((f) => f.fieldKey === 'iin');
      check('explain: менеджеру ИИН — hidden, как в фактическом ответе', iinRow?.level === 'hidden', JSON.stringify(iinRow));
    }

    // ======================================================================
    // Сквозная канарейка: ни один ответ «чужим» зрителям не нёс защищённых значений
    // ======================================================================
    const strangerRaw = [raw(roster), raw(asMgr), raw(hrMgr), raw(chron), raw(cpTrainee), raw(cpList), raw(cpChron), raw(wsStaff), raw(prevStranger), raw(cpListS), raw(oracle), raw(gs), raw(rc)].join('\n');
    const leaks = [CITY, IIN, String(SALARY + 1000), cpDigits, wDigits, PLANNED].filter((c) => strangerRaw.includes(c));
    check('канарейки не утекли ни в один ответ скрытым зрителям', leaks.length === 0, leaks.join(','));
  } finally {
    await call('POST', '/visibility/me/reset', S.token, { fieldKeys: personalReset }).catch(() => {});
    await call('PATCH', '/users/me', S.token, { city: null, bio: null, iin: null, residentialAddress: null }).catch(() => {});
    await call('DELETE', `/workspaces/${W}`, O.token).catch(() => {});
  }
  await finish();
}

main().catch(crash);
