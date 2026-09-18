# ============================================================
# Учение ротации корня движка ключей — на ВРЕМЕННОЙ базе и отдельной Redis-БД.
#
# Живой keystore разработчика не трогается: создаётся база `sa6_rootdrill`, два файла
# корня во временной папке, API поднимается на порту 3011 три раза:
#   1) корень A            — keystore создаётся под A;
#   2) корень A + NEXT=B   — окно двух корней: перешивка порциями, новые версии — под B;
#   3) корень B            — после ротации всё открывается корнем B;
#   4) корень A (негатив)  — бут обязан упасть: версии обёрнуты чужим корнем.
# В конце база, Redis-БД и файлы корня удаляются.
#
# Запуск из apps/api (после `npx nest build`):  pwsh scripts/keys-root-rotation-drill.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$api = Split-Path -Parent $PSScriptRoot
Set-Location $api

$envLine = (Get-Content .env | Select-String -Pattern '^DATABASE_URL=' | Select-Object -First 1).ToString()
$dbUrl = $envLine.Split('=', 2)[1].Trim('"')
if ($dbUrl -notmatch '^(postgres(?:ql)?://)([^:]+):([^@]*)@([^/]+)/([^?]+)(\?.*)?$') { throw 'DATABASE_URL has an unexpected shape' }
$dbUser = $Matches[2]
$drillDb = 'sa6_rootdrill'
$drillUrl = "$($Matches[1])$($Matches[2]):$($Matches[3])@$($Matches[4])/$drillDb$($Matches[6])"
$redisLine = (Get-Content .env | Select-String -Pattern '^REDIS_URL=' | Select-Object -First 1).ToString()
$redisBase = ($redisLine.Split('=', 2)[1].Trim('"')) -replace '/\d+$', ''
$drillRedis = "$redisBase/9"
$port = 3011
$base = "http://localhost:$port"
$tmp = Join-Path $env:TEMP "sa6-rootdrill-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Force $tmp | Out-Null
$rootA = Join-Path $tmp 'root-a.key'
$rootB = Join-Path $tmp 'root-b.key'
$fails = 0
$proc = $null

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "✓  $name  $detail" } else { Write-Host "✗ FAIL  $name  $detail"; $script:fails++ }
}

function Stop-Api {
  if ($script:proc -and -not $script:proc.HasExited) { Stop-Process -Id $script:proc.Id -Force -Confirm:$false; $script:proc.WaitForExit(10000) | Out-Null }
  $script:proc = $null
}

function Start-Api([string]$root, [string]$next, [string]$log) {
  Stop-Api
  # Учение гасит процессы жёстко — их записи в перекличке жили бы ещё три минуты, и команда
  # ротации честно отказала бы («не все инстансы держат следующий корень»). Имитируем, что старых нет.
  docker exec superapp6-redis redis-cli -n 9 DEL keys:instances | Out-Null
  $env:NODE_ENV = 'development'
  $env:DATABASE_URL = $drillUrl
  $env:REDIS_URL = $drillRedis
  $env:PORT = "$port"
  $env:KEYS_ROOT_KEY_FILE = $root
  if ($next) { $env:KEYS_ROOT_KEY_FILE_NEXT = $next } else { Remove-Item Env:KEYS_ROOT_KEY_FILE_NEXT -ErrorAction SilentlyContinue }
  $script:proc = Start-Process -FilePath node -ArgumentList 'dist/main' -WorkingDirectory $api -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  foreach ($i in 1..60) {
    if ($script:proc.HasExited) { return $false }
    try { $r = Invoke-WebRequest -Uri "$base/.well-known/jwks.json" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { return $true } } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

function Api([string]$method, [string]$path, $body = $null, [string]$token = $null) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $req = @{ Method = $method; Uri = "$base/api$path"; Headers = $headers; ContentType = 'application/json'; UseBasicParsing = $true }
  if ($null -ne $body) { $req['Body'] = ($body | ConvertTo-Json -Compress) }
  return (Invoke-WebRequest @req).Content | ConvertFrom-Json
}

try {
  Write-Host "== drill database $drillDb, redis db 9, port $port"
  docker exec superapp6-db psql -U $dbUser -d postgres -c "DROP DATABASE IF EXISTS $drillDb" | Out-Null
  docker exec superapp6-db psql -U $dbUser -d postgres -c "CREATE DATABASE $drillDb" | Out-Null
  docker exec superapp6-redis redis-cli -n 9 FLUSHDB | Out-Null
  $env:DATABASE_URL = $drillUrl
  npx prisma migrate deploy | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy failed on the drill database' }
  node scripts/keys-init-root.cjs $rootA | Out-Null
  node scripts/keys-init-root.cjs $rootB | Out-Null

  # ---- 1. Корень A
  Check 'boot under root A' (Start-Api $rootA $null (Join-Path $tmp 'boot1.log'))
  # Аккаунты сьюта сеются через API регистрации — уже в учебную базу
  $env:API_BASE = "$base/api"
  node scripts/seed-test-accounts.cjs | Out-Null
  Remove-Item Env:API_BASE -ErrorAction SilentlyContinue
  $login = Api 'POST' '/auth/login' @{ phone = '+77009990001'; password = 'Test1234!' }
  $token = $login.data.accessToken
  Check 'login on the drill database' ([bool]$token)
  $rt1 = Api 'POST' '/keys/dev/roundtrip' @{ plaintext = 'before-root-rotation' } $token
  Check 'roundtrip under root A' ($rt1.data.roundtripOk -eq $true)
  $st1 = (Api 'GET' '/keys/dev/root/status' $null $token).data
  $kidA = $st1.rootKid
  Check 'status: no next root, everything under A' (($null -eq $st1.nextRootKid) -and ($st1.underCurrent -gt 0) -and ($st1.foreign -eq 0)) "underCurrent=$($st1.underCurrent)"

  # ---- 2. Окно двух корней: A + NEXT=B
  Check 'boot with KEYS_ROOT_KEY_FILE_NEXT (two roots)' (Start-Api $rootA $rootB (Join-Path $tmp 'boot2.log'))
  $token = (Api 'POST' '/auth/login' @{ phone = '+77009990001'; password = 'Test1234!' }).data.accessToken
  $st2 = (Api 'GET' '/keys/dev/root/status' $null $token).data
  $kidB = $st2.nextRootKid
  Check 'status: next root loaded, rotation not started' (($kidB -match '^[0-9a-f]{16}$') -and ($kidB -ne $kidA) -and ($st2.started -eq $false) -and ($st2.underNext -eq 0)) "next=$kidB"
  $total = $st2.underCurrent
  $st3 = (Api 'POST' '/keys/dev/root/rewrap' @{} $token).data
  Check 'rewrap: every version moved under the next root' (($st3.underCurrent -eq 0) -and ($st3.underNext -eq $total) -and ($st3.started -eq $true)) "underNext=$($st3.underNext) of $total"
  $rt2 = Api 'POST' '/keys/dev/roundtrip' @{ plaintext = 'inside-the-window' } $token
  Check 'roundtrip inside the two-root window' ($rt2.data.roundtripOk -eq $true)
  # Новый KEK после начала ротации — сразу под следующим корнем (хвост под старым не растёт)
  $freshScope = @{ type = 'workspace'; id = [guid]::NewGuid().ToString() }
  $rtNew = Api 'POST' '/keys/dev/roundtrip' @{ plaintext = 'new-kek-after-start'; scope = $freshScope } $token
  $st4 = (Api 'GET' '/keys/dev/root/status' $null $token).data
  Check 'a KEK created after the start is wrapped by the next root (exactly +1 under next, 0 under current)' (($rtNew.data.roundtripOk -eq $true) -and ($st4.underCurrent -eq 0) -and ($st4.underNext -eq ($total + 1))) "underCurrent=$($st4.underCurrent) underNext=$($st4.underNext)"

  # ---- 3. Корень B
  Check 'boot under root B only (rotation finished)' (Start-Api $rootB $null (Join-Path $tmp 'boot3.log'))
  $me = Api 'GET' '/users/me' $null $token
  Check 'a token issued before the swap still verifies (signing keys open with root B)' ($me.success -eq $true)
  $rt3 = Api 'POST' '/keys/dev/roundtrip' @{ plaintext = 'after-root-rotation' } $token
  Check 'roundtrip under root B' ($rt3.data.roundtripOk -eq $true)
  $st5 = (Api 'GET' '/keys/dev/root/status' $null $token).data
  Check 'status: current root is B, nothing foreign' (($st5.rootKid -eq $kidB) -and ($st5.foreign -eq 0))

  # ---- 4. Негатив: старый корень A keystore уже не открывает — бут падает
  $bootA = Start-Api $rootA $null (Join-Path $tmp 'boot4.log')
  $errText = (Get-Content (Join-Path $tmp 'boot4.log'), (Join-Path $tmp 'boot4.log.err') -ErrorAction SilentlyContinue | Out-String)
  Check 'boot under the old root A is refused (fail-closed)' ((-not $bootA) -and ($errText -match 'wrapped by another root|does not hold the root'))
}
finally {
  Stop-Api
  foreach ($n in 'DATABASE_URL', 'REDIS_URL', 'PORT', 'KEYS_ROOT_KEY_FILE', 'KEYS_ROOT_KEY_FILE_NEXT') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
  docker exec superapp6-db psql -U $dbUser -d postgres -c "DROP DATABASE IF EXISTS $drillDb" | Out-Null
  docker exec superapp6-redis redis-cli -n 9 FLUSHDB | Out-Null
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
if ($fails -gt 0) { Write-Host "❌ $fails FAIL"; exit 1 } else { Write-Host '✅ ALL PASS' }
