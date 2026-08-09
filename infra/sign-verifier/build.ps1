# ============================================================
# Сборка верификатора электронной подписи (движок core/sign).
#
# Собирает ПРИВАТНЫЙ образ superapp6/sign-verifier:local: обвязка NCANode (MIT)
# + SDK KalkanCrypt НУЦ РК (лицензия запрещает перераспространение — образ
# наружу не публикуется, см. LICENSING.md) + корневые сертификаты.
#
# Рунбук целиком — README.md рядом.
#   .\infra\sign-verifier\build.ps1            # обычная сборка
#   .\infra\sign-verifier\build.ps1 -Check     # только проверить предпосылки
# ============================================================
param(
  [switch]$Check,
  [string]$Tag = 'superapp6/sign-verifier:local'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail($message) {
  Write-Host "✗ $message" -ForegroundColor Red
  exit 1
}
function Ok($message) { Write-Host "✓ $message" -ForegroundColor Green }

# --- Предпосылки, которых не даёт репозиторий ---
# Обе — внешние и обе заказываются человеком; собирать без них бессмысленно,
# а собрать «почти» хуже, чем не собрать: получится верификатор, который
# всё подтверждает.
$vendor = Join-Path $root 'vendor'
$roots = Join-Path $root 'roots'

if (-not (Test-Path $vendor) -or -not (Get-ChildItem $vendor -File -ErrorAction SilentlyContinue)) {
  Fail @"
Нет SDK KalkanCrypt в infra/sign-verifier/vendor/.
Заявка — на sdk.pki.gov.kz (бесплатно, онлайн). Подробности — README.md, шаг 1.
"@
}
Ok 'SDK на месте'

if (-not (Test-Path $roots) -or -not (Get-ChildItem $roots -File -ErrorAction SilentlyContinue)) {
  Fail @"
Нет корневых сертификатов в infra/sign-verifier/roots/.
Скачать с pki.gov.kz — ВСЕ ТРИ семейства: ГОСТ 34.310-2004, ГОСТ-2015, RSA.
Без старых корней половина живых ключей страны получит «сертификат не подходит».
"@
}
Ok 'Корневые сертификаты на месте'

$pins = Join-Path $root 'pins.env'
$commit = (Select-String -Path $pins -Pattern '^NCANODE_COMMIT=(.*)$').Matches.Groups[1].Value
if (-not $commit) {
  Write-Host '⚠ NCANODE_COMMIT в pins.env пуст — сборка пойдёт с плавающей головы ветки.' -ForegroundColor Yellow
  Write-Host '  Зафиксируйте коммит после первой успешной сборки: иначе «пересобрали без изменений» однажды поменяет поведение.' -ForegroundColor Yellow
}

if ($Check) {
  Ok 'Предпосылки проверены — можно собирать'
  exit 0
}

Write-Host "Сборка $Tag …" -ForegroundColor Cyan
docker build -f (Join-Path $root 'Dockerfile') -t $Tag $root
if ($LASTEXITCODE -ne 0) { Fail 'docker build завершился с ошибкой' }

Ok "Готово: $Tag"
Write-Host @"

Дальше (README.md, шаг 4):
  docker compose --profile sign up -d
  apps\api\.env:  SIGN_VERIFY_DRIVER=ncanode  и  NCANODE_URL=http://localhost:14579
  node apps\api\scripts\verify-sign.cjs

ВАЖНО: сначала ТЕСТОВЫЙ контур (test.pki.gov.kz) и тестовые сертификаты из SDK,
и только потом боевые ключи.
"@ -ForegroundColor Gray
