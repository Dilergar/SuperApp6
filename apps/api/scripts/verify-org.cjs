/* eslint-disable */
// Орг. структура (B2B) — e2e: вертикаль на графе должностей и объектов.
// Дерево (голова отдела → вверх, переопределение reportsTo, корень → владелец),
// объект как отдел по умолчанию, разрешение по объекту, вакансии не рвут вертикаль,
// инверсия «мой руководитель ⇔ моя команда», замещения (датированные/запасные/цикл),
// смешанные циклы → 400, isPrimary, основной объект, проекция head-рёбер и
// неприкосновенность чужих рёбер, областные права, увольнение зама, 409 на голове.
// Run (API up + seeded suite accounts): node scripts/verify-org.cjs
const { PrismaClient } = require('@prisma/client');
const { call, login, makeChecker, SUITE } = require('./_lib.cjs');

const { check, finish } = makeChecker();
// «Сегодня» — как считает сервер: календарная дата в APP_TIMEZONE (Asia/Almaty), не UTC.
const almatyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (days) => {
  const d = new Date(almatyToday + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function main() {
  const prisma = new PrismaClient();
  const s1 = await login(SUITE.p1), s2 = await login(SUITE.p2), s3 = await login(SUITE.p3);
  const t1 = s1.token, t2 = s2.token, t3 = s3.token;
  const u1 = s1.id, u2 = s2.id, u3 = s3.id;

  const cleanup = { wsId: null };
  try {
    // ===== Организация + основной объект =====
    const ws = await call('POST', '/workspaces', t1, { name: 'org-e2e' });
    check('организация создана', ws.ok, `status ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.wsId = wsId;
    const S = (p) => `/workspaces/${wsId}/staff${p}`;
    const O = (p) => `/workspaces/${wsId}/org${p}`;

    const dir0 = (await call('GET', S(''), t1)).json?.data;
    const defBranch = dir0?.branches?.find((b) => b.isDefault);
    check('основной объект создан вместе с организацией (имя организации)', !!defBranch && defBranch.name === 'org-e2e', JSON.stringify(dir0?.branches?.map((b) => [b.name, b.isDefault])));

    // ===== Люди: u2/u3 — Сотрудники =====
    for (const [p, t] of [[SUITE.p2, t2], [SUITE.p3, t3]]) {
      const inv = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: p });
      check(`приглашение ${p}`, inv.ok, `status ${inv.status}`);
      const mine = (await call('GET', '/workspaces/invitations/incoming', t)).json?.data?.find((i) => i.workspaceId === wsId);
      const acc = await call('POST', `/workspaces/invitations/${mine?.id}/accept`, t);
      check(`принятие ${p}`, acc.ok, `status ${acc.status}`);
    }
    await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'staff' });
    await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t1, { role: 'staff' });

    // ===== Справочники =====
    const mk = async (path, body, name) => {
      const r = await call('POST', S(path), t1, body);
      check(name, r.ok, `status ${r.status} ${JSON.stringify(r.json?.message ?? '')}`);
      return r.json?.data?.id;
    };
    const depFin = await mk('/departments', { name: 'Финансовый' }, 'отдел Финансовый');
    const depBuh = await mk('/departments', { name: 'Бухгалтерия', parentId: depFin }, 'подотдел Бухгалтерия');
    const depSrv = await mk('/departments', { name: 'Сервис' }, 'отдел Сервис');

    const posCEO = await mk('/positions', { name: 'CEO', glyph: 'crown' }, 'должность CEO (без отдела, значок)');
    const posCFO = await mk('/positions', { name: 'CFO', reportsToPositionId: posCEO }, 'должность CFO (вне отдела, reportsTo CEO)');
    const posGlav = await mk('/positions', { name: 'Главный бухгалтер', departmentId: depBuh }, 'должность Главбух');
    const posBuh = await mk('/positions', { name: 'Бухгалтер', departmentId: depBuh }, 'должность Бухгалтер');
    const posRukSrv = await mk('/positions', { name: 'Руководитель сервиса', departmentId: depSrv, reportsToPositionId: posCFO }, 'должность Руководитель сервиса (reportsTo CFO)');
    const posBarista = await mk('/positions', { name: 'Бариста', departmentId: depSrv }, 'должность Бариста');
    const posUpr = await mk('/positions', { name: 'Управляющий точкой' }, 'должность Управляющий (без отдела)');
    const posProd = await mk('/positions', { name: 'Продавец' }, 'должность Продавец (без отдела)');

    const brA = await mk('/branches', { name: 'Алматы-1', headPositionId: posUpr }, 'объект Алматы-1 (голова Управляющий)');
    const brB = await mk('/branches', { name: 'Астана-2', headPositionId: posUpr }, 'объект Астана-2 (голова Управляющий)');
    const brC = await mk('/branches', { name: 'Шымкент-3', headPositionId: posUpr }, 'объект Шымкент-3 (голова Управляющий, без людей)');

    const headFin = await call('PATCH', S(`/departments/${depFin}`), t1, { headPositionId: posCFO });
    check('голова Финансового = CFO (лежит ВНЕ отдела)', headFin.ok, `status ${headFin.status}`);
    const headBuh = await call('PATCH', S(`/departments/${depBuh}`), t1, { headPositionId: posGlav });
    check('голова Бухгалтерии = Главбух', headBuh.ok, `status ${headBuh.status}`);
    const headSrv = await call('PATCH', S(`/departments/${depSrv}`), t1, { headPositionId: posRukSrv });
    check('голова Сервиса = Руководитель сервиса (вакантна)', headSrv.ok, `status ${headSrv.status}`);
    const headDef = await call('PATCH', S(`/branches/${defBranch.id}`), t1, { headPositionId: posCEO });
    check('голова основного объекта (штаб) = CEO', headDef.ok, `status ${headDef.status}`);

    // ===== Назначения =====
    const assign = async (token, userId, body, name, expect = 201) => {
      const r = await call('POST', S(`/members/${userId}/assignments`), token, body);
      check(name, r.status === expect, `status ${r.status} ${r.json?.message ?? ''}`);
      return r.json?.data;
    };
    const aCEO = await assign(t1, u1, { positionId: posCEO }, 'CEO → владелец (без объекта → основной)');
    check('назначение без объекта попало в ОСНОВНОЙ объект', aCEO?.branchId === defBranch?.id && aCEO?.isPrimary === true, JSON.stringify([aCEO?.branchName, aCEO?.isPrimary]));
    const aCFO = await assign(t1, u2, { positionId: posCFO }, 'CFO → suite2');
    const aGlav = await assign(t1, u3, { positionId: posGlav }, 'Главбух → suite3 (первое = основное)');
    check('первое назначение — основное', aGlav?.isPrimary === true);
    const aBar = await assign(t1, u3, { positionId: posBarista }, 'Бариста → suite3 (второе)');
    check('второе назначение — НЕ основное', aBar?.isPrimary === false);
    const aUprA = await assign(t1, u2, { positionId: posUpr, branchId: brA }, 'Управляющий@Алматы-1 → suite2');
    const aUprB = await assign(t1, u1, { positionId: posUpr, branchId: brB }, 'Управляющий@Астана-2 → suite1');
    const aProdA = await assign(t1, u3, { positionId: posProd, branchId: brA }, 'Продавец@Алматы-1 → suite3');
    const aProdB = await assign(t1, u3, { positionId: posProd, branchId: brB }, 'Продавец@Астана-2 → suite3');
    const aProdC = await assign(t1, u3, { positionId: posProd, branchId: brC }, 'Продавец@Шымкент-3 → suite3');

    // ===== Вертикаль: GET /org/people/:userId/line =====
    const line = async (token, userId, q = '') => (await call('GET', O(`/people/${userId}/line${q}`), token)).json?.data;
    const mgr = async (userId, assignmentId) => (await line(t1, userId, `?assignmentId=${assignmentId}`))?.manager;

    const mBar = await mgr(u3, aBar.id);
    check('Бариста → голова Сервиса вакантна → выше по reportsTo → CFO (suite2)', mBar?.positionId === posCFO && mBar?.userIds?.length === 1 && mBar.userIds[0] === u2 && mBar.reason === 'position', JSON.stringify(mBar));
    const mGlav = await mgr(u3, aGlav.id);
    check('Главбух → Бухгалтерия (голова = он сам) → Финансовый → CFO по дереву', mGlav?.positionId === posCFO && mGlav?.userIds?.[0] === u2, JSON.stringify(mGlav));
    const mCFO = await mgr(u2, aCFO.id);
    check('CFO → CEO ПЕРЕОПРЕДЕЛЕНИЕМ (без него был бы вторым корнем)', mCFO?.positionId === posCEO && mCFO?.userIds?.[0] === u1, JSON.stringify(mCFO));
    const mCEO = await mgr(u1, aCEO.id);
    check('CEO → корень → фолбэк на владельца с reason=owner_fallback', mCEO?.positionId === null && mCEO?.reason === 'owner_fallback' && mCEO?.userIds?.[0] === u1, JSON.stringify(mCEO));

    const mProdA = await mgr(u3, aProdA.id);
    check('объект = отдел по умолчанию: Продавец без отдела @Алматы-1 → Управляющий Алматы-1 (suite2)', mProdA?.positionId === posUpr && mProdA?.userIds?.[0] === u2 && mProdA?.branchId === brA, JSON.stringify(mProdA));
    const mProdB = await mgr(u3, aProdB.id);
    check('разрешение по объекту: Продавец @Астана-2 → Управляющий Астана-2 (suite1), не Алматы', mProdB?.positionId === posUpr && mProdB?.userIds?.[0] === u1, JSON.stringify(mProdB));
    const mProdC = await mgr(u3, aProdC.id);
    check('многообъектная должность без держателя в объекте → ВВЕРХ (владелец), не управляющий чужой точки', mProdC?.reason === 'owner_fallback' && mProdC?.userIds?.[0] === u1 && mProdC?.positionId === null, JSON.stringify(mProdC));

    const lineDefault = await line(t3, u3);
    check('line без параметров считает по ОСНОВНОМУ назначению', lineDefault?.resolvedAssignmentId === aGlav.id && lineDefault?.manager?.positionId === posCFO, JSON.stringify([lineDefault?.resolvedAssignmentId, aGlav.id]));
    check('line: «также» — руководители по прочим назначениям', Array.isArray(lineDefault?.others) && lineDefault.others.length === 4, `=${lineDefault?.others?.length}`);
    check('line: цепочка вверх по должностям (Главбух → CFO → CEO)', lineDefault?.chain?.map((s) => s.positionId).join(',') === [posCFO, posCEO].join(','), JSON.stringify(lineDefault?.chain?.map((s) => s.positionId)));
    check('line: люди приезжают батчем для чипов', !!lineDefault?.people?.[u2]?.firstName);

    // ===== Инверсия: я ∈ подчинённые(рук) ⇔ рук ∈ managerOf(я, назначение) =====
    const roster = (await call('GET', `/workspaces/${wsId}/members`, t1)).json?.data ?? [];
    let inversionOk = true;
    const teamOf = {};
    for (const m of roster) teamOf[m.userId] = (await line(t1, m.userId))?.team?.userIds ?? [];
    for (const m of roster) {
      for (const a of m.assignments ?? []) {
        const r = await mgr(m.userId, a.id);
        for (const boss of r?.userIds ?? []) {
          if (boss === m.userId) continue;
          if (!teamOf[boss]?.includes(m.userId)) { inversionOk = false; console.log('   inversion miss', m.userId, a.positionName, '→', boss); }
        }
      }
    }
    for (const boss of Object.keys(teamOf)) {
      for (const sub of teamOf[boss]) {
        const subM = roster.find((m) => m.userId === sub);
        const subAssignments = subM?.assignments ?? [];
        let found = false;
        // Человек ВНЕ структуры тоже чей-то подчинённый: руководитель считается без
        // назначения (вертикаль упирается в корень → владелец). Обход только по
        // назначениям объявлял бы таких людей «лишними» в команде.
        if (subAssignments.length === 0) {
          const r = (await line(t1, sub))?.manager;
          if (r?.userIds?.includes(boss)) found = true;
        }
        for (const a of subAssignments) {
          const r = await mgr(sub, a.id);
          if (r?.userIds?.includes(boss)) found = true;
        }
        if (!found) { inversionOk = false; console.log('   inversion extra', boss, '⇐', sub); }
      }
    }
    check('инверсия managerOf ⇔ subordinateIdsOf сходится по каждому назначению', inversionOk);
    check('команда владельца: все, чья вертикаль упирается в него', teamOf[u1]?.includes(u2) && teamOf[u1]?.includes(u3), JSON.stringify(teamOf[u1]));

    // Вершина структуры: владелец сам себе руководитель — ОСОЗНАННОЕ поведение
    // (движки трактуют как «решает владелец»), витрины показывают заглушку.
    const ownerLine = (await line(t1, u1))?.manager;
    check('вершина: руководитель владельца = он сам с reason owner_fallback', ownerLine?.reason === 'owner_fallback' && ownerLine?.userIds?.length === 1 && ownerLine.userIds[0] === u1, JSON.stringify(ownerLine));
    check('владелец не числится в своей же команде', !teamOf[u1]?.includes(u1), JSON.stringify(teamOf[u1]));

    // ===== Свежесть снимка: имя из справочника доезжает до схемы =====
    // Снимок кэшируется (15 с процесс / 600 с Redis) и НЕСЁТ НАЗВАНИЯ — «неструктурная»
    // правка обязана его сбрасывать, иначе схема живёт старым именем до TTL.
    await call('GET', O('/chart'), t1); // прогрев
    await call('PATCH', S(`/departments/${depSrv}`), t1, { name: 'Сервис-переименован' });
    const chartRenamed = (await call('GET', O('/chart'), t1)).json?.data;
    check('переименование отдела видно в /chart сразу', chartRenamed?.departments?.find((d) => d.id === depSrv)?.name === 'Сервис-переименован', JSON.stringify(chartRenamed?.departments?.map((d) => d.name)));
    await call('PATCH', S(`/departments/${depSrv}`), t1, { name: 'Сервис' });
    await call('GET', O('/chart'), t1); // прогрев
    await call('PATCH', S(`/branches/${brC}`), t1, { name: 'Шымкент-переименован' });
    const chartBr = (await call('GET', O('/chart'), t1)).json?.data;
    check('переименование объекта видно в /chart сразу', chartBr?.branches?.find((b) => b.id === brC)?.name === 'Шымкент-переименован', JSON.stringify(chartBr?.branches?.map((b) => b.name)));
    await call('PATCH', S(`/branches/${brC}`), t1, { name: 'Шымкент-3' });

    // ===== Граф =====
    const chart = (await call('GET', O('/chart'), t3)).json?.data;
    check('chart отдаётся команде', !!chart && chart.positions?.length === 8, `=${chart?.positions?.length}`);
    const cp = (id) => chart?.positions?.find((p) => p.id === id);
    check('chart: superiorPositionId — CFO → CEO, Бариста → Руководитель сервиса, CEO → корень', cp(posCFO)?.superiorPositionId === posCEO && cp(posBarista)?.superiorPositionId === posRukSrv && cp(posCEO)?.superiorPositionId === null);
    check('chart: вакансия = должность без держателей', cp(posRukSrv)?.vacant === true && cp(posCFO)?.vacant === false);
    check('chart: голова снаружи отдела — headsDepartmentIds у CFO', cp(posCFO)?.headsDepartmentIds?.includes(depFin));
    check('chart: типовая схема — один корень CEO; Управляющий и Продавец идут под голову ОСНОВНОГО объекта', chart?.roots?.length === 1 && chart.roots[0] === posCEO && cp(posUpr)?.superiorPositionId === posCEO && cp(posProd)?.superiorPositionId === posCEO, JSON.stringify(chart?.roots));
    check('chart: assembled + владелец в схеме + мои должности', chart?.assembled === true && chart?.ownerInChart === true && chart?.myPositionIds?.includes(posGlav));
    const chartA = (await call('GET', O(`/chart?branchId=${brA}`), t1)).json?.data;
    const cpa = (id) => chartA?.positions?.find((p) => p.id === id);
    check('chart?branchId: Продавец → Управляющий; держатели только этого объекта', cpa(posProd)?.superiorPositionId === posUpr && cpa(posProd)?.holders?.length === 1 && cpa(posUpr)?.holders?.[0]?.userId === u2, JSON.stringify([cpa(posProd)?.holders, cpa(posUpr)?.holders]));
    check('chart?branchId: пустая в объекте должность — пунктир (vacant)', cpa(posGlav)?.vacant === true);
    check('chart?branchId: вершина объекта — его руководитель (Управляющий без руководителя в объекте)', cpa(posUpr)?.superiorPositionId === null && chartA?.roots?.includes(posUpr), JSON.stringify(chartA?.roots));
    const unassigned = (await call('GET', O('/unassigned'), t1)).json?.data;
    check('unassigned: вакансия Руководитель сервиса, корни, люди без назначений = 0', unassigned?.vacancies?.some((v) => v.positionId === posRukSrv) && unassigned?.people?.length === 0 && unassigned?.roots?.length === 1, JSON.stringify(unassigned));

    // ===== Замещения =====
    const D = O('/deputies');
    const dep1 = await call('POST', D, t1, { positionId: posCFO, deputyUserId: u1, startsOn: shift(0), endsOn: shift(0) });
    check('датированное замещение CFO ← suite1 (сегодня)', dep1.ok && dep1.json?.data?.kind === 'temporary' && dep1.json?.data?.activeToday === true, `status ${dep1.status} ${dep1.json?.message ?? ''}`);
    const mGlav2 = await mgr(u3, aGlav.id);
    check('сегодня Главбух → зам CFO (suite1) viaDeputy', mGlav2?.userIds?.[0] === u1 && mGlav2?.viaDeputy === true && mGlav2?.deputyUntil === shift(0), JSON.stringify(mGlav2));
    const depUp = await call('PATCH', `${D}/${dep1.json?.data?.id}`, t1, { startsOn: shift(1), endsOn: shift(1) });
    check('период замещения перенесён на завтра', depUp.ok && depUp.json?.data?.activeToday === false, `status ${depUp.status}`);
    const mGlav3 = await mgr(u3, aGlav.id);
    check('завтрашнее замещение сегодня не действует → CFO (suite2)', mGlav3?.userIds?.[0] === u2 && mGlav3?.viaDeputy === false, JSON.stringify(mGlav3));
    const depBad = await call('POST', D, t1, { positionId: posCFO, deputyUserId: u1, deputyPositionId: posCEO });
    check('две цели у замещения → 400', depBad.status === 400, `status ${depBad.status}`);
    const depDup = await call('POST', D, t1, { positionId: posCFO, deputyUserId: u1, startsOn: shift(1), endsOn: shift(1) });
    check('дубль замещения (двойной клик) → 409', depDup.status === 409, `status ${depDup.status}`);
    const depDel = await call('DELETE', `${D}/${dep1.json?.data?.id}`, t1);
    check('замещение снято', depDel.ok, `status ${depDel.status}`);

    const stand = await call('POST', D, t1, { positionId: posRukSrv, deputyUserId: u1 });
    check('запасной (без дат) для вакантного Руководителя сервиса ← suite1', stand.ok && stand.json?.data?.kind === 'standing', `status ${stand.status}`);
    const mBar2 = await mgr(u3, aBar.id);
    check('вакантная должность → запасной (suite1) viaDeputy', mBar2?.positionId === posRukSrv && mBar2?.userIds?.[0] === u1 && mBar2?.viaDeputy === true, JSON.stringify(mBar2));
    const aRuk = await assign(t1, u2, { positionId: posRukSrv }, 'Руководитель сервиса → suite2 (должность занята)');
    const mBar3 = await mgr(u3, aBar.id);
    check('должность занята → запасной НЕ используется (suite2, не зам)', mBar3?.userIds?.[0] === u2 && mBar3?.viaDeputy === false, JSON.stringify(mBar3));
    await call('DELETE', S(`/assignments/${aRuk.id}`), t1);
    const dl = (await call('GET', `${D}?positionId=${posRukSrv}`, t2)).json?.data;
    check('список замещений по должности', Array.isArray(dl) && dl.length === 1 && dl[0].deputyUserId === u1);

    // Цикл замещений A↔B (обе вакантны) завершается, не виснет
    const posX = await mk('/positions', { name: 'Дублёр X' }, 'должность X');
    const posY = await mk('/positions', { name: 'Дублёр Y' }, 'должность Y');
    const posZ = await mk('/positions', { name: 'Стажёр Z', reportsToPositionId: posX }, 'должность Z (reportsTo X)');
    await call('POST', D, t1, { positionId: posX, deputyPositionId: posY });
    await call('POST', D, t1, { positionId: posY, deputyPositionId: posX });
    const aZ = await assign(t1, u3, { positionId: posZ }, 'Z → suite3');
    const started = Date.now();
    const mZ = await mgr(u3, aZ.id);
    check('цикл замещений X↔Y (обе пусты) завершается → выше (голова основного объекта — CEO)', Date.now() - started < 5000 && mZ?.positionId === posCEO && mZ?.userIds?.[0] === u1, JSON.stringify(mZ));
    await call('DELETE', S(`/assignments/${aZ.id}`), t1);

    // ===== Циклы подчинения =====
    const cyc = await call('PATCH', S(`/positions/${posCEO}`), t1, { reportsToPositionId: posGlav });
    check('смешанный цикл (CEO→Главбух→дерево→CFO→CEO) → 400 org_cycle', cyc.status === 400 && cyc.code === 'org_cycle', `status ${cyc.status} code ${cyc.code}`);
    const headSrv2 = await call('PATCH', S(`/departments/${depSrv}`), t1, { headPositionId: posGlav });
    check('голова Сервиса = Главбух (пока не цикл)', headSrv2.ok, `status ${headSrv2.status}`);
    const cyc2 = await call('PATCH', S(`/departments/${depFin}`), t1, { headPositionId: posBarista });
    check('цикл через головы отделов (Бариста→Сервис:Главбух→Бухгалтерия→Финансовый:Бариста) → 400', cyc2.status === 400 && cyc2.code === 'org_cycle', `status ${cyc2.status} code ${cyc2.code}`);
    const headSrv3 = await call('PATCH', S(`/departments/${depSrv}`), t1, { headPositionId: posRukSrv });
    check('голова Сервиса возвращена', headSrv3.ok);
    const repZ = await call('PATCH', S(`/positions/${posZ}`), t1, { reportsToPositionId: null });
    check('снятие переопределения (reportsTo → по структуре)', repZ.ok, `status ${repZ.status}`);
    const selfRep = await call('PATCH', S(`/positions/${posCEO}`), t1, { reportsToPositionId: posCEO });
    check('подчинение самой себе → 400', selfRep.status === 400, `status ${selfRep.status}`);
    // Повреждённые данные (цикл, записанный мимо API) не вешают чтение
    await prisma.staffPosition.update({ where: { id: posCEO }, data: { reportsToPositionId: posCFO } });
    const t0 = Date.now();
    const brokenLine = await call('GET', O(`/people/${u2}/line`), t1);
    const brokenChart = await call('GET', O('/chart'), t1);
    check('повреждённый цикл в БД: line/chart отвечают, не виснут', brokenLine.ok && brokenChart.ok && Date.now() - t0 < 5000, `${brokenLine.status}/${brokenChart.status}`);
    await prisma.staffPosition.update({ where: { id: posCEO }, data: { reportsToPositionId: null } });
    await call('PATCH', S(`/positions/${posCEO}`), t1, { glyph: 'crown' }); // сброс снимка через мутацию

    // ===== isPrimary =====
    const aBar2 = await call('PATCH', S(`/assignments/${aBar.id}`), t1, { isPrimary: true });
    check('переключение основного места на Бариста', aBar2.ok && aBar2.json?.data?.isPrimary === true, `status ${aBar2.status}`);
    const rosterP = (await call('GET', `/workspaces/${wsId}/members`, t1)).json?.data ?? [];
    const m3 = rosterP.find((m) => m.userId === u3);
    check('ровно одно основное место у человека', m3?.assignments?.filter((a) => a.isPrimary).length === 1 && m3.assignments.find((a) => a.isPrimary)?.id === aBar.id, JSON.stringify(m3?.assignments?.map((a) => [a.positionName, a.isPrimary])));
    const primaries = await prisma.staffAssignment.count({ where: { workspaceId: wsId, userId: u3, isPrimary: true } });
    check('партиальный уникум основного места держится', primaries === 1, `=${primaries}`);
    const delBar = await call('DELETE', S(`/assignments/${aBar.id}`), t1);
    check('снятие основного назначения', delBar.ok, `status ${delBar.status}`);
    const promoted = await prisma.staffAssignment.findFirst({ where: { workspaceId: wsId, userId: u3, isPrimary: true }, select: { id: true } });
    check('удаление основного повышает следующее по createdAt (Главбух)', promoted?.id === aGlav.id, `=${promoted?.id}`);
    const nullBranch = await call('PATCH', S(`/assignments/${aGlav.id}`), t1, { branchId: null });
    check('назначение без объекта не бывает: branchId=null → 400', nullBranch.status === 400, `status ${nullBranch.status}`);

    // ===== Основной объект =====
    const delDef = await call('DELETE', S(`/branches/${defBranch.id}`), t1);
    check('удалить основной объект → 409 org_default_branch', delDef.status === 409 && delDef.code === 'org_default_branch', `status ${delDef.status} code ${delDef.code}`);
    const unsetDef = await call('PATCH', S(`/branches/${defBranch.id}`), t1, { isDefault: false });
    check('снять флаг основного → 400 (перенос флага — явным действием)', unsetDef.status === 400, `status ${unsetDef.status}`);
    const setDefC = await call('PATCH', S(`/branches/${brC}`), t1, { isDefault: true });
    check('перенос флага на Шымкент-3', setDefC.ok, `status ${setDefC.status}`);
    const dirD = (await call('GET', S(''), t1)).json?.data;
    check('ровно один основной объект после переноса', dirD?.branches?.filter((b) => b.isDefault).length === 1 && dirD.branches.find((b) => b.isDefault)?.id === brC);
    const setDefBack = await call('PATCH', S(`/branches/${defBranch.id}`), t1, { isDefault: true });
    check('флаг возвращён', setDefBack.ok);

    // ===== Проекция в core/access =====
    const tuples = await prisma.relationTuple.findMany({
      where: { subjectType: 'user', resourceType: { in: ['department', 'branch'] }, relation: 'head' },
      select: { resourceType: true, resourceId: true, relation: true, subjectId: true },
    });
    const has = (rt, rid, uid) => tuples.some((t) => t.resourceType === rt && t.resourceId === rid && t.subjectId === uid);
    check('department#head@suite2 на Финансовый (CFO — голова снаружи)', has('department', depFin, u2));
    check('department#head@suite2 на Бухгалтерию (closure ВНИЗ)', has('department', depBuh, u2));
    check('department#head@suite3 на Бухгалтерию (Главбух)', has('department', depBuh, u3));
    check('department#head НЕ на Финансовый у Главбуха (closure только вниз)', !has('department', depFin, u3));
    check('branch#head@suite2 на Алматы-1 (держатель В ЭТОМ объекте)', has('branch', brA, u2));
    check('branch#head@suite1 на Астана-2', has('branch', brB, u1));
    check('branch#head НЕ у suite2 на Астана-2 (управляющий чужой точки)', !has('branch', brB, u2));
    check('branch#head НЕ на Шымкент-3 (никто там не работает Управляющим)', !tuples.some((t) => t.resourceType === 'branch' && t.resourceId === brC));
    // Голова снаружи — участник отдела через ЛЕСТНИЦУ (head ⇒ member в check() и grantSetFor),
    // сырого member-ребра на сам отдел проекция не пишет (лестница = union-цепочка типа);
    // сквозная проверка «грант отделу достаёт руководителя» — verify-audiences.cjs.
    const memberOfFin = await prisma.relationTuple.count({ where: { resourceType: 'department', resourceId: depFin, relation: 'member', subjectType: 'user', subjectId: u2 } });
    check('голова снаружи: member-ребра на сам отдел нет (даёт лестница), head — есть', memberOfFin === 0, `=${memberOfFin}`);

    // Чужое ребро (явное делегирование) ПЕРЕЖИВАЕТ мутацию Staff
    await prisma.relationTuple.create({ data: { resourceType: 'department', resourceId: depSrv, relation: 'manager', subjectType: 'user', subjectId: u3, subjectRelation: '' } });
    await call('PATCH', S(`/positions/${posBuh}`), t1, { description: 'touch' });
    await assign(t1, u2, { positionId: posBuh }, 'мутация после ручного ребра');
    const survived = await prisma.relationTuple.count({ where: { resourceType: 'department', resourceId: depSrv, relation: 'manager', subjectId: u3 } });
    check('вручную вписанное department#manager ПЕРЕЖИВАЕТ resync проекции', survived === 1, `=${survived}`);
    // Делегат правит ветку наравне с головой
    const scope3 = (await call('GET', O('/my-scope'), t3)).json?.data;
    check('my-scope suite3: scoped, Бухгалтерия (голова) + Сервис (делегат)', scope3?.kind === 'scoped' && scope3.departmentIds.includes(depBuh) && scope3.departmentIds.includes(depSrv) && !scope3.departmentIds.includes(depFin), JSON.stringify(scope3));
    await prisma.relationTuple.deleteMany({ where: { resourceType: 'department', resourceId: depSrv, relation: 'manager', subjectId: u3 } });

    // ===== Областные права =====
    const scope3b = (await call('GET', O('/my-scope'), t3)).json?.data;
    check('my-scope suite3 (Сотрудник-голова Бухгалтерии): только своя ветка', scope3b?.kind === 'scoped' && scope3b.departmentIds.length === 1 && scope3b.departmentIds[0] === depBuh, JSON.stringify(scope3b));
    const scope1 = (await call('GET', O('/my-scope'), t1)).json?.data;
    check('my-scope владельца: all', scope1?.kind === 'all');
    const ownRename = await call('PATCH', S(`/departments/${depBuh}`), t3, { name: 'Бухгалтерия и учёт' });
    check('голова правит СВОЮ ветку → 200', ownRename.ok, `status ${ownRename.status}`);
    const otherRename = await call('PATCH', S(`/departments/${depSrv}`), t3, { name: 'Сервис-2' });
    check('голова правит ЧУЖОЙ отдел → 403 org_scope_forbidden', otherRename.status === 403 && otherRename.code === 'org_scope_forbidden', `status ${otherRename.status} code ${otherRename.code}`);
    const newBranch = await call('POST', S('/branches'), t3, { name: 'Самовольный объект' });
    check('голова отдела НЕ создаёт объекты → 403', newBranch.status === 403, `status ${newBranch.status}`);
    const rootDep = await call('POST', S('/departments'), t3, { name: 'Самовольный корень' });
    check('голова отдела НЕ создаёт корневой отдел → 403', rootDep.status === 403, `status ${rootDep.status}`);
    const subDep = await call('POST', S('/departments'), t3, { name: 'Касса', parentId: depBuh });
    check('голова создаёт подотдел в своей ветке → 201', subDep.ok, `status ${subDep.status}`);
    const posInScope = await call('POST', S('/positions'), t3, { name: 'Кассир', departmentId: subDep.json?.data?.id });
    check('голова создаёт должность в своей ветке → 201', posInScope.ok, `status ${posInScope.status}`);
    await assign(t3, u2, { positionId: posInScope.json?.data?.id }, 'голова назначает в своей ветке (равный ранг) → 201');
    await assign(t3, u2, { positionId: posBarista }, 'голова назначает в ЧУЖОЙ отдел → 403', 403);
    await assign(t3, u1, { positionId: posBuh }, 'назначение человеку с БОЛЕЕ высокой ролью → 403', 403);
    // Голова объекта (suite2 — Управляющий Алматы-1) правит назначения СВОЕГО объекта
    await assign(t2, u3, { positionId: posProd, branchId: brA }, 'голова объекта: дубль в своём объекте → 409', 409);
    const aProdA2 = await call('DELETE', S(`/assignments/${aProdA.id}`), t2);
    check('голова объекта снимает назначение в своём объекте → 200', aProdA2.ok, `status ${aProdA2.status}`);
    await assign(t2, u3, { positionId: posProd, branchId: brA }, 'голова объекта назначает в свой объект → 201');
    await assign(t2, u3, { positionId: posUpr, branchId: brB }, 'голова объекта в ЧУЖОЙ объект → 403', 403);
    const scope2 = (await call('GET', O('/my-scope'), t2)).json?.data;
    check('my-scope suite2: Финансовый+Бухгалтерия (CFO) и объект Алматы-1', scope2?.kind === 'scoped' && scope2.departmentIds.includes(depFin) && scope2.departmentIds.includes(depBuh) && scope2.branchIds.length === 1 && scope2.branchIds[0] === brA, JSON.stringify(scope2));
    const mgrFull = await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'manager' });
    const scope2m = (await call('GET', O('/my-scope'), t2)).json?.data;
    check('Менеджер полновластен (STAFF_FULL_SCOPE_ROLES)', mgrFull.ok && scope2m?.kind === 'all');
    await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'staff' });

    // ===== Мастер «Соберём структуру» =====
    const setup = await call('POST', O('/setup'), t1, { top: { positionId: posCEO }, departmentHeads: [{ departmentId: subDep.json?.data?.id, positionId: posInScope.json?.data?.id }], branchHeads: [] });
    check('setup: голова подотдела назначена', setup.ok && setup.json?.data?.departmentsUpdated === 1, `status ${setup.status} ${JSON.stringify(setup.json?.data)}`);
    const setupBad = await call('POST', O('/setup'), t3, { departmentHeads: [{ departmentId: depSrv, positionId: null }] });
    check('setup — только полновластным → 403', setupBad.status === 403, `status ${setupBad.status}`);

    // ===== Удаление головы → 409 =====
    const delHead = await call('DELETE', S(`/positions/${posRukSrv}`), t1);
    check('удалить должность-голову (вакантную) → 409 org_head_in_use', delHead.status === 409 && delHead.code === 'org_head_in_use', `status ${delHead.status} code ${delHead.code}`);

    // ===== Хроника структуры =====
    const journalRows = await prisma.chatterEntry.findMany({ where: { workspaceId: wsId }, select: { typeKey: true } });
    const keys = new Set(journalRows.map((e) => e.typeKey));
    check('журнал: staff.head_set / branch_head_set / reports_to_set / deputy_opened / primary_changed / default_branch_changed', ['staff.head_set', 'staff.branch_head_set', 'staff.reports_to_set', 'staff.deputy_opened', 'staff.primary_changed', 'staff.default_branch_changed'].every((k) => keys.has(k)), [...keys].join(','));

    // ===== Увольнение закрывает замещения зама =====
    const depFire = await call('POST', D, t1, { positionId: posCFO, deputyUserId: u3 });
    check('запасной CFO ← suite3', depFire.ok, `status ${depFire.status}`);
    const fire = await call('DELETE', `/workspaces/${wsId}/members/${u3}`, t1);
    check('увольнение suite3', fire.ok, `status ${fire.status}`);
    const leftDeputies = await prisma.staffDeputy.count({ where: { workspaceId: wsId, deputyUserId: u3 } });
    check('замещения уволенного закрыты', leftDeputies === 0, `=${leftDeputies}`);
    const leftHead = await prisma.relationTuple.count({ where: { resourceType: 'department', relation: 'head', subjectId: u3, resourceId: depBuh } });
    check('head-ребро уволенного снято', leftHead === 0, `=${leftHead}`);
    const rosterF = (await call('GET', `/workspaces/${wsId}/members`, t1)).json?.data ?? [];
    const mBuh = await mgr(u2, (rosterF.find((m) => m.userId === u2)?.assignments ?? []).find((a) => a.positionName === 'Бухгалтер')?.id);
    check('голова без держателей → вертикаль сама поднимается выше (Бухгалтер → Главбух пуст → CFO=сам → CEO)', mBuh?.positionId === posCEO && mBuh?.userIds?.[0] === u1, JSON.stringify(mBuh));

    // ===== Наём БЕЗ должности при ТЁПЛОМ снимке =====
    // Снимок несёт живые роли: приглашение без должности рёбер прав не пишет, но
    // состав команды меняет. Без сброса новичок до истечения TTL «не в организации»:
    // line отвечал 404, manager_of — пустотой, а согласование отказывалось
    // активировать шаг «руководитель» (empty_assignees).
    await call('GET', O('/chart'), t1); // прогрев снимка ПОСЛЕ увольнения
    const inv2 = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: SUITE.p3 });
    check('повторное приглашение suite3 (без должности)', inv2.ok, `status ${inv2.status}`);
    const mine3 = (await call('GET', '/workspaces/invitations/incoming', t3)).json?.data?.find((i) => i.workspaceId === wsId);
    const acc3 = await call('POST', `/workspaces/invitations/${mine3?.id}/accept`, t3);
    check('принятие приглашения без должности', acc3.ok, `status ${acc3.status}`);
    const line3 = await call('GET', O(`/people/${u3}/line`), t1);
    check('новичок без должности виден оргструктуре СРАЗУ (не 404)', line3.status === 200, `status ${line3.status} ${JSON.stringify(line3.json?.message ?? '')}`);
    check('руководитель новичка сразу = владелец (owner_fallback)', line3.json?.data?.manager?.reason === 'owner_fallback' && line3.json?.data?.manager?.userIds?.[0] === u1, JSON.stringify(line3.json?.data?.manager));
    const ownerTeam2 = (await line(t1, u1))?.team?.userIds ?? [];
    check('новичок вне структуры входит в команду владельца (инверсия по членству)', ownerTeam2.includes(u3), JSON.stringify(ownerTeam2));
    const aud3 = await call('POST', '/audiences/dev/resolve', t3, { workspaceId: wsId, refs: [{ type: 'manager_of', id: '$initiator' }] });
    check('адресат manager_of для новичка не пуст (шаг согласования активируется)', (aud3.json?.data?.userIds ?? []).includes(u1), JSON.stringify(aud3.json?.data?.userIds));
  } finally {
    if (cleanup.wsId) {
      await prisma.workspaceInvitation.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => {});
    }
    await prisma.$disconnect();
  }
  finish();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
