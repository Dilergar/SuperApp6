# Точка входа сборки редактора документов с Windows.
#
# Это тонкий драйвер: вся линуксовая логика живёт в run-build.sh, здесь только
# запуск контейнера и правильные ограничения ресурсов. PowerShell, а не .bat —
# конвенция репозитория (см. CLAUDE.md: сборки на Windows идут через PowerShell).
#
#   .\infra\docs-editor\build.ps1 -Stage base     # долго, раз на пин исходников
#   .\infra\docs-editor\build.ps1 -Stage brand    # секунды, здесь итерируем бренд
#   .\infra\docs-editor\build.ps1 -Stage all -FlushDiscovery
[CmdletBinding()]
param(
    [ValidateSet('base', 'brand', 'all')]
    [string]$Stage = 'all',

    # Разрешить новый/несовпавший sha256 ассета движка. Осознанный шаг: без него
    # расхождение — жёсткая ошибка, чтобы перезалив upstream не менял версию молча.
    [switch]$AcceptNewAsset,

    # Сбросить Redis-кэш discovery. Обязательно после КАЖДОЙ пересборки: в urlsrc
    # зашит хэш сборки, и протухшая запись уводит iframe в 404 на целый час,
    # не оставляя ни одной ошибки на сервере.
    [switch]$FlushDiscovery,

    # Сколько ядер отдать компиляции. НЕ трогайте вверх без .wslconfig: WSL2 по
    # умолчанию забирает себе только половину RAM (у нас ~8 ГБ), а линковка C++
    # на всех 20 потоках уходит в OOM. --cpuset-cpus меняет то, что видит nproc;
    # --cpus (в отличие от него) не меняет.
    [int]$Jobs = 6
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')

function Read-Pins {
    $pins = @{}
    Get-Content (Join-Path $here 'pins.env') | ForEach-Object {
        if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $pins[$Matches[1]] = $Matches[2].Trim() }
    }
    return $pins
}

function Invoke-Checked([string]$what, [scriptblock]$block) {
    Write-Host "`n==> $what" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE -ne 0) { throw "$what — провалилось (код $LASTEXITCODE)" }
}

$pins = Read-Pins
$baseImage  = "$($pins.IMAGE_BASE):$($pins.BASE_TAG)"
$brandImage = "$($pins.IMAGE_BRAND):$($pins.BASE_TAG)-b$($pins.BRAND_REV)"

Write-Host "редактор документов SuperApp6" -ForegroundColor Green
Write-Host "  ветка   : $($pins.ONLINE_BRANCH) @ $($pins.ONLINE_COMMIT.Substring(0,7))"
Write-Host "  base    : $baseImage"
Write-Host "  brand   : $brandImage"

if ($Stage -in @('base', 'all')) {
    # Ядер у сборщика ровно $Jobs — иначе make -j$(nproc) внутри build.sh увидит все 20.
    $cpuset = "0-$($Jobs - 1)"

    Invoke-Checked "Собираю образ-сборщик" {
        docker build -t superapp6/docs-editor-builder:1 -f (Join-Path $here 'Dockerfile.builder') $here
    }

    Invoke-Checked "Собираю base из исходников (это надолго)" {
        docker run --rm `
            -v /var/run/docker.sock:/var/run/docker.sock `
            -v "${here}:/work:ro" `
            -v superapp6-docs-editor-build:/build `
            -v superapp6-docs-editor-assets:/assets `
            --cpuset-cpus $cpuset `
            -e MAKEFLAGS="-j$Jobs" `
            -e ACCEPT_NEW_ASSET=$(if ($AcceptNewAsset) { '1' } else { '' }) `
            superapp6/docs-editor-builder:1
    }
}

if ($Stage -in @('brand', 'all')) {
    Invoke-Checked "Накладываю бренд и шрифты" {
        docker build -t $brandImage `
            --build-arg BASE=$baseImage `
            -f (Join-Path $here 'Dockerfile.brand') $here
    }
}

if ($FlushDiscovery) {
    # Кэш живёт в Redis самого приложения, поэтому это отдельный флаг: команда
    # трогает работающую систему, а не только сборку.
    Invoke-Checked "Сбрасываю кэш discovery" {
        docker exec superapp6-redis sh -c "redis-cli --scan --pattern 'docs:discovery:*' | xargs -r redis-cli del"
    }
}

Write-Host "`nГотово. Дальше:" -ForegroundColor Green
Write-Host "  1) пропишите образ в docker-compose.yml   ->  $brandImage"
Write-Host "  2) docker compose --profile docs up -d"
Write-Host "  3) сбросьте кэш discovery, если не делали  ->  -FlushDiscovery"
Write-Host "  4) cd apps/api; node scripts/verify-docs.cjs"
