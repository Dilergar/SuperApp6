/* eslint-disable */
// Общий помощник verify-сьютов и сида: согласия движка core/consents.
//  - registrationConsents(base)  — поле `consents` для POST /verify/start и POST /auth/register
//    (действующие версии пакета `registration`; в development регистрация без SMS берёт его из тела);
//  - acceptAllPending(base, token) — принять всё, что ждёт принятия у человека и у организаций,
//    которыми он владеет (после учений публикации новых версий аккаунты сьюта и человека
//    не должны оставаться за блокирующим экраном).
async function getJson(base, path, token) {
  const res = await fetch(`${base}${path}`, { headers: { 'X-Locale': 'ru', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const text = await res.text();
  try { return { status: res.status, ok: res.ok, json: text ? JSON.parse(text) : null }; } catch { return { status: res.status, ok: res.ok, json: null }; }
}
async function postJson(base, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Locale': 'ru', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  try { return { status: res.status, ok: res.ok, json: text ? JSON.parse(text) : null }; } catch { return { status: res.status, ok: res.ok, json: null }; }
}

async function registrationConsents(base, opts = {}) {
  const r = await getJson(base, '/consents/bundles/registration');
  const data = r.json?.data;
  if (!r.ok || !data) throw new Error(`consents bundle: ${r.status}`);
  const versionIds = data.documents.map((d) => d.versionId);
  if (opts.marketing) versionIds.push(...data.optional.filter((d) => d.documentKey === 'marketing').map((d) => d.versionId));
  return { versionIds, locale: opts.locale || 'ru', channel: 'api' };
}

async function acceptAllPending(base, token) {
  const p = await getJson(base, '/consents/pending', token);
  if (!p.ok) return { ok: false, status: p.status };
  const mine = [...(p.json.data.blocking || []), ...(p.json.data.upcoming || [])].map((d) => d.versionId);
  let accepted = 0;
  if (mine.length) {
    const r = await postJson(base, '/consents/accept', token, { versionIds: [...new Set(mine)], locale: 'ru', channel: 'api' });
    if (r.ok) accepted += r.json.data.accepted.length;
  }
  for (const ws of p.json.data.workspaces || []) {
    if (!ws.canAccept) continue;
    const ids = [...ws.blocking, ...ws.upcoming].map((d) => d.versionId);
    if (!ids.length) continue;
    const r = await postJson(base, '/consents/accept', token, { versionIds: [...new Set(ids)], locale: 'ru', channel: 'api', workspaceId: ws.workspaceId });
    if (r.ok) accepted += r.json.data.accepted.length;
  }
  return { ok: true, accepted };
}

module.exports = { registrationConsents, acceptAllPending };
