#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================
// Смоук S3-кандидата: то, на что опираются движок файлов и бэкапы (docs/operations_backup_dr.md)
// ============================================================
// Провайдер «S3-совместим» на словах часто расходится в деталях, которые всплывают в аварию:
// многочастная загрузка, срок подписи ссылки, пагинация списка, версии, Object Lock, коды ошибок.
// Скрипт гоняет их на отдельном префиксе и убирает за собой (все версии префикса).
//
//   node apps/api/scripts/s3-conformance.cjs                          — адрес и ключи из S3_* (.env)
//   node apps/api/scripts/s3-conformance.cjs --require-versioning --require-object-lock
//                                                                     — бакет бэкапов: обязательно
//   S3_CONFORMANCE_BUCKET=sa6-pgbackrest-city1 node …                 — другой бакет
//
// Выход 0 — всё обязательное прошло; необязательное без флага — предупреждение, не провал.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const REQUIRE_VERSIONING = process.argv.includes('--require-versioning');
const REQUIRE_LOCK = process.argv.includes('--require-object-lock');
const MIN_LOCK_DAYS = 36;
const bucket = process.env.S3_CONFORMANCE_BUCKET || process.env.S3_BUCKET;
const prefix = `conformance/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}/`;

let fails = 0;
let warns = 0;
const check = (name, ok, extra, required = true) => {
  const mark = ok ? '✓' : required ? '✗ FAIL' : '! WARN';
  console.log(`${mark}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) required ? fails++ : warns++;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = async (res) => Buffer.from(await res.Body.transformToByteArray());
const errCode = (e) => e?.name || e?.Code || e?.$metadata?.httpStatusCode;

function client(creds) {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: creds ?? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  });
}

async function main() {
  if (!process.env.S3_ENDPOINT || !bucket) throw new Error('S3_ENDPOINT and S3_BUCKET (or S3_CONFORMANCE_BUCKET) are required');
  const s3 = client();
  console.log(`endpoint ${process.env.S3_ENDPOINT} · bucket ${bucket} · prefix ${prefix}\n`);

  // ---- 1. Простая запись и чтение ----
  const small = crypto.randomBytes(64 * 1024);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}small.bin`, Body: small, ContentType: 'application/x-sa6-test' }));
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}small.bin` }));
  check('put/get: байты совпадают', sha(await body(got)) === sha(small));
  check('put/get: тип содержимого сохранён', got.ContentType === 'application/x-sa6-test', got.ContentType);
  const range = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}small.bin`, Range: 'bytes=10-19' }));
  const part = await body(range);
  check('чтение диапазона (Range) — 10 байт с нужного места', part.length === 10 && part.equals(small.subarray(10, 20)), `${part.length}`);

  // ---- 2. Многочастная загрузка ----
  const P = 5 * 1024 * 1024;
  const parts = [crypto.randomBytes(P), crypto.randomBytes(P), crypto.randomBytes(1024 * 1024)];
  const mp = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${prefix}big.bin` }));
  const etags = [];
  for (let i = 0; i < parts.length; i++) {
    const r = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: `${prefix}big.bin`, UploadId: mp.UploadId, PartNumber: i + 1, Body: parts[i] }));
    etags.push({ ETag: r.ETag, PartNumber: i + 1 });
  }
  const done = await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: `${prefix}big.bin`, UploadId: mp.UploadId, MultipartUpload: { Parts: etags } }));
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}big.bin` }));
  check('многочастная: размер собранного объекта', head.ContentLength === P * 2 + 1024 * 1024, String(head.ContentLength));
  check('многочастная: ETag вида «…-3»', /-3"?$/.test(done.ETag ?? head.ETag ?? ''), done.ETag ?? head.ETag, false);
  const whole = await body(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}big.bin` })));
  check('многочастная: байты совпадают', sha(whole) === sha(Buffer.concat(parts)));
  const aborted = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${prefix}aborted.bin` }));
  await s3.send(new UploadPartCommand({ Bucket: bucket, Key: `${prefix}aborted.bin`, UploadId: aborted.UploadId, PartNumber: 1, Body: parts[2] }));
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: `${prefix}aborted.bin`, UploadId: aborted.UploadId }));
  const leftovers = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
  check('многочастная: прерванная загрузка не висит (нет брошенных частей)', !(leftovers.Uploads ?? []).length, String((leftovers.Uploads ?? []).length));

  // ---- 3. Подписанные ссылки и их срок ----
  const urlOk = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}small.bin` }), { expiresIn: 60 });
  const r1 = await fetch(urlOk);
  check('подписанная ссылка GET работает в срок', r1.status === 200 && sha(Buffer.from(await r1.arrayBuffer())) === sha(small), String(r1.status));
  const urlShort = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}small.bin` }), { expiresIn: 2 });
  await sleep(4000);
  const r2 = await fetch(urlShort);
  check('подписанная ссылка после срока отвергается (403)', r2.status === 403, String(r2.status));
  const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: `${prefix}presigned-put.bin`, ContentType: 'application/octet-stream' }), { expiresIn: 60 });
  const r3 = await fetch(putUrl, { method: 'PUT', body: small, headers: { 'Content-Type': 'application/octet-stream' } });
  check('подписанная ссылка PUT (прямая загрузка клиента)', r3.status === 200, String(r3.status));
  const tampered = urlOk.replace(/X-Amz-Signature=([0-9a-f])/, (m, c) => `X-Amz-Signature=${c === '0' ? '1' : '0'}`);
  const r4 = await fetch(tampered);
  check('подпись с правкой отвергается (403)', r4.status === 403, String(r4.status));

  // ---- 4. Пагинация списка ----
  for (let i = 0; i < 7; i++) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}list/${String(i).padStart(2, '0')}`, Body: 'x' }));
  const seen = [];
  let token;
  let pages = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}list/`, MaxKeys: 3, ContinuationToken: token }));
    seen.push(...(page.Contents ?? []).map((o) => o.Key));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    pages++;
  } while (token && pages < 10);
  check('ListObjectsV2: 7 ключей тремя страницами по 3, по порядку', seen.length === 7 && pages === 3 && seen.every((k, i) => k.endsWith(String(i).padStart(2, '0'))), `${seen.length} keys / ${pages} pages`);

  // ---- 5. Коды ошибок ----
  const missing = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}nope` })).then(() => 'found').catch(errCode);
  check('нет ключа → NoSuchKey', missing === 'NoSuchKey' || missing === 404, String(missing));
  const bad = client({ accessKeyId: process.env.S3_ACCESS_KEY_ID || 'x', secretAccessKey: 'definitely-wrong-secret' });
  const denied = await bad.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}small.bin` })).then(() => 'allowed').catch(errCode);
  check('неверный секрет → отказ (SignatureDoesNotMatch/AccessDenied)', denied !== 'allowed', String(denied));

  // ---- 6. Версии ----
  const ver = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket })).catch(() => ({}));
  const versioned = ver.Status === 'Enabled';
  check('версионирование бакета включено', versioned, ver.Status ?? 'off', REQUIRE_VERSIONING);
  if (versioned) {
    const k = `${prefix}versioned.txt`;
    const v1 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: 'one' }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: 'two' }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: k }));
    check('версии: две версии + маркер удаления', (versions.Versions ?? []).length === 2 && (versions.DeleteMarkers ?? []).length === 1);
    const old = await body(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: k, VersionId: v1.VersionId })));
    check('версии: старая версия читается по VersionId после удаления', old.toString() === 'one');
  }

  // ---- 7. Object Lock ----
  const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket })).catch(() => null);
  const rule = lock?.ObjectLockConfiguration?.Rule?.DefaultRetention;
  const lockDays = rule?.Days ?? (rule?.Years ? rule.Years * 365 : 0);
  check(`Object Lock: включён, режим GOVERNANCE/COMPLIANCE, срок ≥ ${MIN_LOCK_DAYS} дней`, lock?.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled' && !!rule?.Mode && lockDays >= MIN_LOCK_DAYS, rule ? `${rule.Mode} ${lockDays}d` : 'off', REQUIRE_LOCK);
  if (lock?.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled') {
    const k = `${prefix}locked.bin`;
    const v = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: 'locked' }));
    const del = await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k, VersionId: v.VersionId })).then(() => 'deleted').catch(errCode);
    check('Object Lock: версию под удержанием не удалить без обхода', del !== 'deleted', String(del));
  }

  // ---- Уборка: все версии префикса (под удержанием — с обходом governance, если права есть) ----
  let removed = 0;
  let vToken;
  let kToken;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: kToken, VersionIdMarker: vToken })).catch(() => null);
    if (!page) break;
    const objs = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
    if (objs.length) {
      const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs }, BypassGovernanceRetention: true })).catch(() => null);
      removed += r?.Deleted?.length ?? 0;
    }
    kToken = page.IsTruncated ? page.NextKeyMarker : undefined;
    vToken = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (kToken);
  if (!versioned) {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })).catch(() => ({ Contents: [] }));
    for (const o of list.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key })).then(() => removed++).catch(() => undefined);
  }
  console.log(`\ncleanup: ${removed} object version(s) removed`);
  console.log(fails === 0 ? `\n✅ ALL PASS${warns ? ` (${warns} warning(s))` : ''}` : `\n❌ ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
