# Разведка поверхностей брендинга в НАШЕМ собранном образе.
#
# Список файлов, которые надо заменить, невозможно узнать заранее: репозиторий тем
# Collabora приватный (SSH-only), их SDK-документация закрыта анти-ботом, а пути
# отличаются между версиями. Поэтому список выводится из артефакта — четыре прохода,
# каждый ловит то, что пропустил предыдущий.
#
#   .\infra\docs-editor\probe.ps1                 # проходы A, B, D по образу
#   .\infra\docs-editor\probe.ps1 -CheckLicenses  # + проверка «оверлей не съел атрибуцию»
#
# Прохода C (рантайм-водопад: запросы страницы, document.title, favicon, диалог
# «О программе», чужие origin) здесь нет намеренно — он делается в браузере на живом
# редакторе, потому что ловит ровно то, что не видно ни в grep, ни в имени файла.
[CmdletBinding()]
param(
    [string]$Image,
    [switch]$CheckLicenses
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Image) {
    $pins = @{}
    Get-Content (Join-Path $here 'pins.env') | ForEach-Object {
        if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $pins[$Matches[1]] = $Matches[2].Trim() }
    }
    $Image = "$($pins.IMAGE_BRAND):$($pins.BASE_TAG)-b$($pins.BRAND_REV)"
}
Write-Host "образ: $Image" -ForegroundColor Green

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Section 'Проход A. Текст «collabora» внутри образа'
Write-Host 'Разложите вывод на три корзины (см. brand/manifest.md): лицензии — не трогать,'
Write-Host 'марки в UI — в оверлей, внутренние идентификаторы — оставить.'
docker run --rm --entrypoint sh $Image -c `
    "grep -ril collabora /usr/share/coolwsd /etc/coolwsd 2>/dev/null | sort"

Section 'Проход B. Ассеты по имени (grep не видит содержимое PNG/SVG)'
docker run --rm --entrypoint sh $Image -c `
    "find /usr/share/coolwsd/browser/dist \( -iname '*collabora*' -o -iname '*logo*' -o -iname '*brand*' -o -iname '*about*' -o -iname '*favicon*' -o -iname '*.ico' \) 2>/dev/null | sort"

Section 'Проход D. Протокольные поверхности'
Write-Host '-- метки образа --'
docker inspect --format '{{json .Config.Labels}}' $Image
Write-Host '-- версия coolwsd (сюда попадает --with-vendor / --with-app-name) --'
docker run --rm --entrypoint /usr/bin/coolwsd $Image --version 2>&1 | Select-Object -First 5
Write-Host '-- локали: нужны ru (мы открываем редактор с lang=ru-RU) и kk (рынок КЗ) --'
docker run --rm --entrypoint sh $Image -c `
    "ls /usr/share/coolwsd/browser/dist/l10n/ 2>/dev/null | grep -E '^(ui|help)-(ru|kk)\.json' | tr '\n' ' '; echo"
Write-Host '-- шрифты: метрические замены обязаны находиться, иначе .docx поедет --'
docker run --rm --entrypoint sh $Image -c `
    "fc-match Calibri; fc-match Cambria; fc-match 'Times New Roman'; echo -n 'кириллических шрифтов: '; fc-list :lang=ru | wc -l"

if ($CheckLicenses) {
    Section 'Контроль: оверлей не съел атрибуцию'
    Write-Host 'MPL-2.0 §3.4 запрещает удалять уведомления о лицензии и авторских правах.'
    Write-Host 'Снимая ТОВАРНЫЕ ЗНАКИ, легко задеть их заодно — поэтому проверяем явно.'
    Write-Host 'Искать надо в /opt/collaboraoffice (там движок и его лицензии), а НЕ только'
    Write-Host 'в /usr/share/coolwsd: в браузерной части файлы лицензий называются иначе.'

    $checks = @(
        @{ n = 'LICENSE движка';        c = "test -s /opt/collaboraoffice/LICENSE && echo ok" },
        @{ n = 'NOTICE движка';         c = "test -s /opt/collaboraoffice/NOTICE && echo ok" },
        @{ n = 'CREDITS движка';        c = "test -s /opt/collaboraoffice/CREDITS.fodt && echo ok" },
        @{ n = 'копирайт Collabora';    c = "grep -qi collabora /opt/collaboraoffice/LICENSE && echo ok" },
        @{ n = 'наш NOTICE';            c = "test -s /usr/share/doc/superapp6-docs-editor/NOTICE && echo ok" }
    )
    $bad = 0
    foreach ($chk in $checks) {
        $r = docker run --rm --entrypoint sh $Image -c $chk.c 2>$null
        if ($r -match 'ok') { Write-Host ("  ok   " + $chk.n) -ForegroundColor Green }
        else { Write-Host ("  ПРОВАЛ " + $chk.n) -ForegroundColor Red; $bad++ }
    }
    if ($bad -eq 0) { Write-Host 'Атрибуция на месте.' -ForegroundColor Green }
    else { Write-Host "Удалено то, что обязаны были сохранить: $bad шт." -ForegroundColor Red }
}

Write-Host "`nДальше — проход C в браузере на живом редакторе:" -ForegroundColor Yellow
Write-Host '  document.title, <link rel=icon>, тулбар, Help -> About,'
Write-Host '  и главное: НОЛЬ запросов на origin, кроме нашего редактора и нашего API.'
