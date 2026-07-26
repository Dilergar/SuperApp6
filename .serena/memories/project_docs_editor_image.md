# Своя сборка редактора документов (L2) — `infra/docs-editor/`

Готовый образ `collabora/code` ЗАМЕНЁН собственной обезличенной сборкой из исходников
Collabora Online (MPL-2.0). Сделано 26.07.2026 поверх движка `core/docs`
(см. `mem:project_docs_engine`), коммит `b0ee029`.

**Итог:** образ `superapp6/docs-editor:26.04-52df04e-b1` в docker-compose (сервис
переименован `collabora` → `docs-editor`, порт 9980 сохранён → `.env` не менялся).
verify-docs.cjs **64/0** (не SKIP), включая конвертацию в PDF; та же база снималась ДО
подмены на старом образе — совпадает. Регрессии зелёные: files, files-consumers,
messenger, messenger-task, tasks-access, tasks-inbox, jobs, chatter, access. В браузере:
документ открылся, мост postMessage жив, **ноль запросов на посторонние origin**,
ноль ВИДИМЫХ элементов с чужой маркой.

## Зачем (настоящая причина, а не та, что казалась)

Дело **не** в лимитах и **не** в формулировке «CODE подходит для домашнего
использования» — это рекомендация, а не запрет; никакого EULA, запрещающего
коммерческое использование образа, в первоисточниках нет.

1. **Бинарники vs исходники.** Collabora на своей странице условий прямо разделяет:
   исполняемые формы (в терминах MPL §3.2(b)) распространяются «with additional
   conditions under a proprietary license», а исходники — чистый MPL-2.0. Готовый
   docker-образ = такая исполняемая форма. Сборка из исходников снимает вопрос.
2. **Товарные знаки.** Их политика ТРЕБУЕТ: «you must remove all trademark uses of
   the Marks from the version … you are modifying». Обезличивание — условие, не прихоть.
3. **Лимиты 10 документов / 20 соединений — МИФ.** Проверено в `configure.ac`:
   `MAX_CONNECTIONS=9999`, `MAX_DOCUMENTS=9999`. Строки помощи всё ещё пишут
   «Def: 20» — устаревшая документация. Миф родом из треда Nextcloud 2016 года.
   Флаги всё равно проставляем явно, но продавать это как «снятие лимитов» нечестно.
   Реальный потолок на ~50 одновременных — сайзинг, а не константы компиляции.

Модель распространения — **только SaaS** → MPL §3.2 не срабатывает, исходники отдавать
некому. Живут §3.4 (сохранять уведомления) и §2.3 (нет прав на марки).

## Выбор ветки — исходное предположение было ОБРАТНЫМ

`distro/collabora/co-26.04`, коммит `52df04ea84a2fea550558e02a54ec5d89a05c080`.

Готовый движок LibreOffice (`ENGINE_ASSETS`, сборка за минуты вместо часов) умеет брать
**только новая обвязка** — она на `co-26.04`/`main`. На `co-25.04` `build.sh` старый:
всегда клонирует `git.libreoffice.org/core` и собирает его сам, плюс отдельно собирает
static POCO, а `docker/from-source/README.md` там дословно «FIXME. This folder needs to
be updated for Collabora Online 23.05».

Побочно co-26.04 меняет и другое: её `ENTRYPOINT` — чистый `/usr/bin/coolwsd
--use-env-vars …`, тогда как у co-25.04 это `start-collabora-online.sh`.

Ассет — `engine-main-assets.tar.gz` (от main = 26.04.3.0; ветка 26.04.2.4, одна линия).
Ассеты перезаливают по тому же URL → в `pins.env` закреплён sha256.

## Подмена в compose оказалась почти однострочной

Планировалось переносить конфигурацию в примонтированный `coolwsd.xml`, но чтение
`wsd/COOLWSD.cpp` показало: флаг `--use-env-vars` заставляет **сам coolwsd** читать
`aliasgroup1..N` (цикл), `extra_params` (токенизируется и дописывается в argv),
`DONT_GEN_SSL_CERT`, `cert_domain`, `username`, `password`, `server_name`,
`dictionaries`, `content_security_policy`, `remoteconfigurl`. Раньше это разбирал
entrypoint-скрипт образа CODE. Поэтому блок `environment:` перенесён ДОСЛОВНО,
отдельный XML не понадобился, прод — `prod.env.example`.

## Ловушки сборки (все стоили по кругу диагностики)

1. **Node из Ubuntu 24.04 — 18.19**, а `configure.ac` требует >= 20.0.0 и обрывается.
   Ставим 22 из NodeSource.
2. **`wget` не умеет `file://`** («Unsupported scheme»), хотя `curl` умеет. Ассет
   раздаётся локальным HTTP на 127.0.0.1 — дешевле, чем патчить upstream.
3. **В ассете движка НЕТ POCO**: он собирается в `workdir` дерева движка, а ассет —
   это только `instdir`. configure сам печатает «falling back to system POCO», но
   системный обязан быть.
4. **POCO из Ubuntu — 1.11.0, требуется >= 1.12.0** (компайл-тайм проверка
   `Poco/Version.h`). Собираем 1.12.5p2 из исходников в `/usr/local`. 1.13.0 брать
   нельзя — configure ловит её как заведомо битую.
5. **Список `--omit` для POCO нельзя копировать со старой ветки.** Там был выброшен
   Zip, а co-26.04 использует его в `wsd/Unzip.cpp`. Выбрасываем только заведомо
   тяжёлое и ненужное (драйверы БД, MongoDB, Redis, PDF, PageCompiler, ActiveRecord).
6. **САМАЯ ПОУЧИТЕЛЬНАЯ: пропущенный `libexpat1-dev` уронил сборку в чужом файле.**
   Симптом: `common/Syscall.cpp: error: 'set_fds_cloexec_nonblock' was not declared`.
   Настоящая цепочка: `-lexpat` в LIBS → падает ЛИНКОВКА тестовых программ configure →
   `AC_CHECK_FUNCS` проверяет функции линковкой → разом «пропали» `ppoll`, `memrchr`,
   `pipe2` (все есть в glibc) → `HAVE_PIPE2=no` → компилируется ветка «для платформ
   без pipe2, вроде macOS» → там и лежит недообъявленная функция.
   **Правило: configure отрицает заведомо существующее → идти в `config.log` за
   `cannot find -l`.** При этом `-lpfm`/`-ldld` там норма, а `cannot find -lPoco*` — нет.

**Порядок слоёв `Dockerfile.builder` неслучаен:** POCO (10 минут) стоит РАНЬШЕ основного
списка зависимостей, иначе каждый забытый пакет выбрасывает его кэш.

**Риск, который НЕ материализовался:** опасение «build.sh упадёт на клоне приватного
репозитория брендинга» снято чтением исходника — клон стоит с `|| echo`, а сам шаг
обёрнут в `if test -d`. В логе это выглядит как безобидное `cannot run ssh`.

## Обезличивание: заменено РОВНО два файла

1. **`branding.js`** — главный. `cool.html` подключает `/browser/<hash>/branding.js`
   ВСЕГДА, но в сборке из исходников его нет (его генерирует приватный `brand.sh`), и
   запрос отдаёт 404. Из-за этого глобальная `brandProductName` не определена, и клиент
   подставляет своё запасное имя «Collabora Online Development Edition (unbranded)» —
   оно и попадает в «О программе». **Серверный `user_interface.brandProductName` до
   браузера НЕ доезжает** — клиент читает именно глобальную переменную. Кладём свой файл:
   `brandProductName='SuperApp6'`, `brandProductURL=''`, `brandProductFAQURL=''`.
   Это штатная точка расширения (рядом с `%BRANDING_CSS%`/`%BRANDING_JS%` в cool.html),
   а не патч чужого файла.
2. **`images/collabora-office-white.svg`** — единственная картинка-марка, подставляется
   как `background-image` из `bundle.css`/`backstage.css`. Имя оставлено ОРИГИНАЛЬНЫМ
   нарочно: иначе пришлось бы править минифицированный CSS. Пока нейтральная заглушка.

**Отпало само** (сборка из исходников чище образа CODE): `branding.css`, ~20 иконок
`*_branding.svg`, `toolbar-bg-logo*`; экран приветствия (`welcome.enable` уже false,
самого экрана нет); блока `feedback` нет вовсе; `remote_config`/`remote_font_config`
пустые; favicon отсутствует; заголовок вкладки уже нейтральный «Online Editor»;
`lc_about.svg` — обычная иконка «i». Осталась одна чужая ссылка `brandProductURL`
в конфиге — гасится пустым значением в compose.

**Минифицированный `bundle.js` НЕ патчим.** В нём есть зашитые «Collabora Online» и
адрес их issue-трекера, в `cool.html` — статический `<h1 id="product-name">`. Всё это
НЕ видно: `#about-dialog` имеет `display:none`, а при открытии JS перезаписывает
заголовок значением `brandProductName`. Патч был бы и хрупким (ломается на каждом
обновлении), и хуже по лицензии: правка чужого файла = изменённый covered file,
тогда как свой `branding.js` — наш код (MPL §3.3).

## Что даёт эталон брендинга

Прогон `probe.ps1` по официальному `collabora/code:24.04.13.1.1` (там их приватный
`brand.sh` применён) показывает поверхности бренда: `branding.css/js`,
`branding-mobile/tablet.css`, `images/toolbar-bg-logo*.svg`, ~20 иконок
`images/*_branding.svg`, `cool.html`, `cool-help.html`, `bundle.js`, `admin-bundle.js`,
`l10n/descriptions-*.json`. Наша сборка идёт БЕЗ `brand.sh` + название задано
`--with-app-name=SuperApp6`, поэтому список замен ожидается заметно короче.
Побочно: образ CODE построен на **Debian 12**, а наша сборка — на **Ubuntu 24.04**.

## Инварианты эксплуатации

* **После КАЖДОЙ пересборки сбрасывать Redis-кэш `docs:discovery:*`** — в адресе
  редактора зашит хэш сборки, `DocsEditorClient` кэширует его на час, и протухшая
  запись уводит iframe в 404 БЕЗ единой ошибки на сервере.
* **Пакет образов остаётся ПРИВАТНЫМ**: публикация = распространение исполняемой формы,
  и §3.2 включается немедленно.
* **Оверлей не трогает `COPYING*`/`LICENSE*`/`licenses/`/`NOTICE`/копирайт-шапки**
  (§3.4). Проверка в `probe.ps1 -CheckLicenses`: после оверлея grep обязан вернуть
  корзину лицензий И ТОЛЬКО ЕЁ; пустой результат = удалили обязательное.
* **Сервис переименован `collabora` → `docs-editor`**, поэтому первый раз нужен
  `docker compose --profile docs down --remove-orphans`: старый контейнер стал
  «сиротой» и держит порт 9980.
* Старый образ `collabora/code` НЕ удалять, пока новый не отработает — это путь отката
  (вернуть тег + сбросить кэш discovery).

## Ожидаемый шум в логе (не чинить выдачей прав)

На старте — три `ERR` про `CLONE_NEWUSER unshare failed` и «Failed to exec coolmount …
needs CAP_SYS_ADMIN». Помощник `coolmount` готовит песочницы через bind-mount, а
CAP_SYS_ADMIN не входит в дефолтный набор Docker. coolwsd сам откатывается на
копирование («Bind-Mounting fails and will be disabled for this run») и работает —
verify-docs зелёный. Выдавать контейнеру SYS_ADMIN ради тишины в логе не стоит.
Штатный `--o:mount_jail_tree=false` шум НЕ убирает (проба отрабатывает до слияния
аргументов), поэтому флаг намеренно НЕ поставлен — он создавал бы ложное впечатление.

## Шрифты

Brand-слой доставляет Carlito/Caladea/Liberation/DejaVu. Проверять `fc-match Calibri`
→ Carlito и `fc-match Cambria` → Caladea: это метрически совместимые замены, без них
`.docx` из Word поедет по переносам и разбивке на страницы. Локали `ru` и `kk` (ui+help)
в сборке есть.

## База для сравнения

`verify-docs.cjs` на СТАРОМ образе — «✅ ВСЁ ЗЕЛЁНОЕ», включая PDF-отпечаток через
`/cool/convert-to/pdf`. Снято до подмены специально, чтобы после было с чем сверять.

Связано: `mem:project_docs_engine`, `mem:project_files_engine`.
