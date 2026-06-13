/* eslint-disable */
// Staff («Сотрудники», B2B) — e2e: справочники Должность/Отдел/Филиал, наём ВСЕГДА в
// Стажёра (без выбора роли, без кулдаунов), назначения со статусом обучения, derived-отдел
// (через должность) + closure предков в core/access, лестница ролей (админа — только
// владелец), изоляция Подрядчика (Коллаб-модель), каскад при увольнении.
// Run (API up + seeded testers): node scripts/verify-staff.cjs
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
const BASE = 'http://localhost:3001/api';
const P1 = '+77001234567', P2 = '+77012345678', P3 = '+77023456789', PW = 'Test1234!';

let fails = 0;
const check = (n, ok, extra) => { console.log(`${ok ? '✓' : '✗ FAIL'}  ${n}${extra ? `  (${extra})` : ''}`); if (!ok) fails++; };
async function call(method, p, token, body, headers) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, json };
}
const login = async (phone) => { const r = await call('POST', '/auth/login', null, { phone, password: PW }); if (!r.ok) throw new Error(`login ${phone}: ${r.status}`); return r.json.data.accessToken; };

async function main() {
  const prisma = new PrismaClient();
  const t1 = await login(P1), t2 = await login(P2), t3 = await login(P3);
  const uid = async (p) => (await prisma.user.findUnique({ where: { phone: p }, select: { id: true } })).id;
  const u1 = await uid(P1), u2 = await uid(P2), u3 = await uid(P3);

  const cleanup = { wsId: null, taskIds: [] };
  try {
    // ===== Организация =====
    const ws = await call('POST', '/workspaces', t1, { name: 'staff-e2e' });
    check('организация создана', ws.ok, `status ${ws.status}`);
    const wsId = ws.json.data.id; cleanup.wsId = wsId;
    const WS = { 'X-Workspace-Id': wsId };
    const S = (p) => `/workspaces/${wsId}/staff${p}`;

    // ===== Справочники =====
    const depFin = await call('POST', S('/departments'), t1, { name: 'Финансовый отдел' });
    check('отдел создан', depFin.ok, `status ${depFin.status}`);
    const depBuh = await call('POST', S('/departments'), t1, { name: 'Бухгалтерия', parentId: depFin.json?.data?.id });
    check('подотдел создан (дерево)', depBuh.ok, `status ${depBuh.status}`);
    const depDup = await call('POST', S('/departments'), t1, { name: 'Финансовый отдел' });
    check('дубль отдела → 409', depDup.status === 409, `status ${depDup.status}`);
    const cyc = await call('PATCH', S(`/departments/${depFin.json?.data?.id}`), t1, { parentId: depBuh.json?.data?.id });
    check('цикл в дереве отделов → 400', cyc.status === 400, `status ${cyc.status}`);

    const posBuh = await call('POST', S('/positions'), t1, { name: 'Бухгалтер', departmentId: depBuh.json?.data?.id });
    check('должность с отделом создана', posBuh.ok, `status ${posBuh.status}`);
    const posOf = await call('POST', S('/positions'), t1, { name: 'Официант' });
    check('должность без отдела создана', posOf.ok, `status ${posOf.status}`);

    const brOffice = await call('POST', S('/branches'), t1, { name: 'Офис 1', address: 'ул. Абая 1' });
    const brAlmaty = await call('POST', S('/branches'), t1, { name: 'Алматинский филиал' });
    check('филиалы созданы', brOffice.ok && brAlmaty.ok, `${brOffice.status}/${brAlmaty.status}`);

    // ===== Наём: всегда Стажёр, должность «с порога», без кулдаунов =====
    const inv2 = await call('POST', `/workspaces/${wsId}/invitations`, t1, {
      phone: P2, positionId: posOf.json?.data?.id, branchIds: [brAlmaty.json?.data?.id, brOffice.json?.data?.id],
    });
    check('приглашение с должностью + НЕСКОЛЬКИМИ филиалами', inv2.ok, `status ${inv2.status}`);
    check('в приглашении нет выбора роли (всегда trainee)', inv2.json?.data?.role === 'trainee', `role=${inv2.json?.data?.role}`);
    check('имя должности в приглашении', inv2.json?.data?.positionName === 'Официант', `=${inv2.json?.data?.positionName}`);
    check('оба филиала в приглашении', (inv2.json?.data?.branchNames ?? []).length === 2, JSON.stringify(inv2.json?.data?.branchNames));

    // Кулдаунов нет: invite → cancel → invite сразу же
    const invA = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P3 });
    await call('POST', `/workspaces/${wsId}/invitations/${invA.json?.data?.id}/cancel`, t1);
    const invB = await call('POST', `/workspaces/${wsId}/invitations`, t1, { phone: P3 });
    check('повторное приглашение сразу после отмены (без кулдауна 24ч)', invB.ok, `status ${invB.status}`);

    const myInv2 = (await call('GET', '/workspaces/invitations/incoming', t2)).json?.data?.find((i) => i.workspaceId === wsId);
    const acc2 = await call('POST', `/workspaces/invitations/${myInv2?.id}/accept`, t2);
    check('принятие найма', acc2.ok, `status ${acc2.status}`);
    check('нанят Стажёром', acc2.json?.data?.myRole === 'trainee', `myRole=${acc2.json?.data?.myRole}`);

    const myInv3 = (await call('GET', '/workspaces/invitations/incoming', t3)).json?.data?.find((i) => i.workspaceId === wsId);
    await call('POST', `/workspaces/invitations/${myInv3?.id}/accept`, t3);

    const roster1 = (await call('GET', `/workspaces/${wsId}/members`, t1)).json?.data ?? [];
    const m2 = roster1.find((m) => m.userId === u2);
    check('назначения из приглашения: ДВА (по одному на филиал), стажируется',
      m2?.assignments?.length === 2
      && m2.assignments.every((a) => a.positionName === 'Официант' && a.status === 'training')
      && new Set(m2.assignments.map((a) => a.branchName)).size === 2,
      JSON.stringify(m2?.assignments?.map((a) => a.branchName)));

    // ===== «Видимость в Компаниях»: карточка коллеги маскируется флагами владельца =====
    const visUp = await call('PATCH', '/users/me', t2, {
      bio: 'staff-e2e bio',
      city: 'Алматы',
      companyCardVisibility: { bio: true, city: false },
    });
    check('PATCH companyCardVisibility принят', visUp.ok, `status ${visUp.status}`);
    const meVis = await call('GET', '/users/me', t2);
    check('GET /users/me отдаёт companyCardVisibility', meVis.json?.data?.companyCardVisibility?.bio === true
      && meVis.json?.data?.companyCardVisibility?.city === false, JSON.stringify(meVis.json?.data?.companyCardVisibility));
    const roster1b = (await call('GET', `/workspaces/${wsId}/members`, t1)).json?.data ?? [];
    const m2c = roster1b.find((m) => m.userId === u2);
    check('карточка коллеги: «О себе» видно (флаг on)', m2c?.card?.bio === 'staff-e2e bio', JSON.stringify(m2c?.card?.bio));
    check('карточка коллеги: город скрыт (флаг off) → null, телефон всегда',
      m2c?.card?.city === null && m2c?.card?.phone === P2, `city=${JSON.stringify(m2c?.card?.city)}`);

    // ===== Стажёр = метка (полные права в текущих сервисах), но не менеджер =====
    const tTask = await call('POST', '/tasks', t2, { title: 'staff-e2e от стажёра', executorId: u1 }, WS);
    check('стажёр ставит задачу коллеге (метка, прав не режем)', tTask.ok, `status ${tTask.status}`);
    if (tTask.ok) cleanup.taskIds.push(tTask.json.data.id);
    const tPos = await call('POST', S('/positions'), t2, { name: 'Хакер' });
    check('стажёр НЕ управляет справочниками → 403', tPos.status === 403, `status ${tPos.status}`);
    const rosterT2 = await call('GET', `/workspaces/${wsId}/members`, t2);
    check('стажёр видит ростер', rosterT2.ok, `status ${rosterT2.status}`);

    // ===== Лестница ролей =====
    const mgr = await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'manager' });
    check('владелец повысил до Менеджера', mgr.ok, `status ${mgr.status}`);
    const mgrBranch = await call('POST', S('/branches'), t2, { name: 'Астанинский филиал 1' });
    check('менеджер управляет справочниками', mgrBranch.ok, `status ${mgrBranch.status}`);
    const mgrInvite = await call('POST', `/workspaces/${wsId}/invitations`, t2, { phone: '+77770000001' });
    check('менеджер нанимает', mgrInvite.ok, `status ${mgrInvite.status}`);
    const mgrRole = await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t2, { role: 'staff' });
    check('менеджер НЕ меняет роли → 403', mgrRole.status === 403, `status ${mgrRole.status}`);

    const adm = await call('PATCH', `/workspaces/${wsId}/members/${u2}`, t1, { role: 'admin' });
    check('владелец назначил Админа', adm.ok, `status ${adm.status}`);
    const admGivesAdm = await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t2, { role: 'admin' });
    check('админ НЕ назначает админов → 403', admGivesAdm.status === 403, `status ${admGivesAdm.status}`);
    const admGivesMgr = await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t2, { role: 'manager' });
    check('админ назначает до Менеджера', admGivesMgr.ok, `status ${admGivesMgr.status}`);
    const admin3 = await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t1, { role: 'admin' });
    const admTouchAdm = await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t2, { role: 'staff' });
    check('админ НЕ трогает другого админа → 403', admin3.ok && admTouchAdm.status === 403, `status ${admTouchAdm.status}`);
    const admFireAdm = await call('DELETE', `/workspaces/${wsId}/members/${u3}`, t2);
    check('админ НЕ увольняет админа → 403', admFireAdm.status === 403, `status ${admFireAdm.status}`);
    const contractorManual = await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t1, { role: 'contractor' });
    check('подрядчика нельзя выставить вручную → 400', contractorManual.status === 400, `status ${contractorManual.status}`);
    await call('PATCH', `/workspaces/${wsId}/members/${u3}`, t1, { role: 'staff' });

    // ===== Назначения: несколько должностей, дубль, аттестация =====
    const as1 = await call('POST', S(`/members/${u3}/assignments`), t1, { positionId: posBuh.json?.data?.id, branchId: brOffice.json?.data?.id });
    check('назначение Бухгалтер@Офис 1', as1.ok, `status ${as1.status}`);
    const asDup = await call('POST', S(`/members/${u3}/assignments`), t1, { positionId: posBuh.json?.data?.id, branchId: brOffice.json?.data?.id });
    check('дубль назначения → 409', asDup.status === 409, `status ${asDup.status}`);
    const as2 = await call('POST', S(`/members/${u3}/assignments`), t1, { positionId: posOf.json?.data?.id });
    check('вторая должность тому же человеку', as2.ok, `status ${as2.status}`);
    const cert = await call('PATCH', S(`/assignments/${as1.json?.data?.id}`), t1, { status: 'certified' });
    check('аттестация (training → certified)', cert.ok && cert.json?.data?.status === 'certified', `status ${cert.status}`);

    // ===== Проекция в core/access: 3 оси + closure предков отдела =====
    const tuples = await prisma.relationTuple.findMany({
      where: { subjectType: 'user', subjectId: u3, resourceType: { in: ['position', 'branch', 'department'] } },
      select: { resourceType: true, resourceId: true, relation: true },
    });
    const hasT = (rt, rid, rel) => tuples.some((t) => t.resourceType === rt && t.resourceId === rid && t.relation === rel);
    check('tuple position#holder', hasT('position', posBuh.json?.data?.id, 'holder'));
    check('tuple branch#member', hasT('branch', brOffice.json?.data?.id, 'member'));
    check('tuple department#member (отдел должности)', hasT('department', depBuh.json?.data?.id, 'member'));
    check('tuple department#member (closure: РОДИТЕЛЬСКИЙ отдел)', hasT('department', depFin.json?.data?.id, 'member'));

    // Справочник со счётчиками (derived отдел через должность)
    const dirRes = (await call('GET', S(''), t1)).json?.data;
    const dBuh = dirRes?.departments?.find((d) => d.id === depBuh.json?.data?.id);
    check('счётчик отдела (derived через должность)', dBuh?.membersCount === 1, `=${dBuh?.membersCount}`);

    // ===== Гейты удаления справочников =====
    const delPos = await call('DELETE', S(`/positions/${posBuh.json?.data?.id}`), t1);
    check('должность с назначениями не удаляется → 409', delPos.status === 409, `status ${delPos.status}`);
    const delBr = await call('DELETE', S(`/branches/${brOffice.json?.data?.id}`), t1);
    check('филиал с людьми не удаляется → 409', delBr.status === 409, `status ${delBr.status}`);

    // ===== Подрядчик (Коллаб-модель): изолирован. Роль выдаётся только сервисами —
    // имитируем будущий «Тайный гость» прямой записью роли. =====
    await prisma.userRole.updateMany({ where: { userId: u3, context: 'workspace', tenantId: wsId }, data: { isActive: false } });
    await prisma.userRole.create({ data: { userId: u3, role: 'contractor', context: 'workspace', tenantId: wsId, grantedBy: u1 } });

    const cRoster = await call('GET', `/workspaces/${wsId}/members`, t3);
    check('подрядчик НЕ видит ростер → 403', cRoster.status === 403, `status ${cRoster.status}`);
    const cDir = await call('GET', S(''), t3);
    check('подрядчик НЕ видит справочники → 403', cDir.status === 403, `status ${cDir.status}`);
    const cTask = await call('POST', '/tasks', t3, { title: 'staff-e2e от подрядчика', executorId: u2 }, WS);
    check('подрядчик НЕ инициирует через пропуск → 403', cTask.status === 403, `status ${cTask.status}`);
    const toC = await call('POST', '/tasks', t2, { title: 'staff-e2e подрядчику', executorId: u3 }, WS);
    check('подрядчик НЕ достижим через пропуск → 403', toC.status === 403, `status ${toC.status}`);
    const assignC = await call('POST', S(`/members/${u3}/assignments`), t1, { positionId: posOf.json?.data?.id, branchId: brAlmaty.json?.data?.id });
    check('подрядчику должность не назначается → 400', assignC.status === 400, `status ${assignC.status}`);

    // вернуть t3 в команду
    await prisma.userRole.updateMany({ where: { userId: u3, context: 'workspace', tenantId: wsId, role: 'contractor' }, data: { isActive: false } });
    await prisma.userRole.updateMany({ where: { userId: u3, context: 'workspace', tenantId: wsId, role: 'staff' }, data: { isActive: true } });

    // ===== Увольнение: каскад назначений + tuples =====
    const fire = await call('DELETE', `/workspaces/${wsId}/members/${u3}`, t1);
    check('увольнение', fire.ok, `status ${fire.status}`);
    const leftAssignments = await prisma.staffAssignment.count({ where: { workspaceId: wsId, userId: u3 } });
    check('назначения уволенного удалены', leftAssignments === 0, `=${leftAssignments}`);
    // Скоуп — только справочники ЭТОЙ организации (в dev-базе у tester3 могут быть
    // легитимные назначения в других воркспейсах — они не должны валить тест).
    const dictIds = [
      ...(await prisma.staffPosition.findMany({ where: { workspaceId: wsId }, select: { id: true } })),
      ...(await prisma.staffBranch.findMany({ where: { workspaceId: wsId }, select: { id: true } })),
      ...(await prisma.staffDepartment.findMany({ where: { workspaceId: wsId }, select: { id: true } })),
    ].map((r) => r.id);
    const leftTuples = await prisma.relationTuple.count({
      where: { subjectType: 'user', subjectId: u3, resourceType: { in: ['position', 'branch', 'department'] }, resourceId: { in: dictIds } },
    });
    check('staff-tuples уволенного сняты', leftTuples === 0, `=${leftTuples}`);
  } finally {
    for (const id of cleanup.taskIds) await call('DELETE', `/tasks/${id}`, t2, null, { 'X-Workspace-Id': cleanup.wsId }).catch(() => {});
    if (cleanup.wsId) {
      await prisma.workspaceInvitation.deleteMany({ where: { workspaceId: cleanup.wsId } }).catch(() => {});
      await call('DELETE', `/workspaces/${cleanup.wsId}`, t1).catch(() => {});
    }
    // Вернуть фикстуру tester2 (анкета/видимость общие для всего сьюта).
    await call('PATCH', '/users/me', t2, { bio: null, city: null, companyCardVisibility: null }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${fails === 0 ? '✅ STAFF («СОТРУДНИКИ») ПРОЙДЕН' : `❌ ПРОВАЛЕНО: ${fails}`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
