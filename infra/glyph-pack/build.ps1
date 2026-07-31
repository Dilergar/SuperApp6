# Точка входа сборки пака значков с Windows.
#
# Тонкий драйвер: вся работа — в build.cjs. PowerShell, а не .bat — конвенция
# репозитория (см. CLAUDE.md: сборки на Windows идут через PowerShell).
#
#   .\infra\glyph-pack\build.ps1                  # всё: эмодзи + иконки + шрифт
#   .\infra\glyph-pack\build.ps1 -Only icons      # только иконки (правка каталога)
#   .\infra\glyph-pack\build.ps1 -SkipFetch       # без сети, на уже скачанном
#   .\infra\glyph-pack\build.ps1 -Force           # перекачать и перерисовать всё
[CmdletBinding()]
param(
    [ValidateSet('emoji', 'icons', 'font')]
    [string]$Only,

    # Не ходить в сеть: собрать из work/, скачанного прошлым запуском.
    [switch]$SkipFetch,

    # Перекачать источники и перерисовать картинки, даже если файлы на месте.
    # Нужен после смены пинов (иначе старые webp останутся лежать как есть).
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$nodeArgs = @((Join-Path $here 'build.cjs'))
if ($Only) { $nodeArgs += @('--only', $Only) }
if ($SkipFetch) { $nodeArgs += '--skip-fetch' }
if ($Force) { $nodeArgs += '--force' }

& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "glyph-pack: сборка упала (код $LASTEXITCODE)" }
