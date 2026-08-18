# Схлопывание пересборок Документов + стоп-кран рекурсии core/sign (2026-08-17)

Починка двух хвостов ревью ЭДО (сьют их обходил ретраями — дефекты были живые).

## 1. Пересборка документа: пара стабильных ключей вместо Date.now()

**Было:** каждый PATCH ставил `documents.generate` с ключом `doc:gen:<id>:${Date.now()}` →
два рендера одного документа бежали ПАРАЛЛЕЛЬНО (очередь documents, 3 слота), второй падал
на оптимистичном замке `replaceContent` («Файл изменён параллельно») → бэкофф движка 30с×2^n →
страж `assertNotRebuilding` держал submit/send-external до минуты+, веб отвечал красным тостом
«попробуйте через несколько секунд» (враньё). Плюс латентный lost-update: поздний рендер
СТАРЫХ данных мог лечь поверх свежих байтов соседа.

**Стало (documents.constants.ts `docGenKey`, documents.jobs.ts, documents.service.ts):**
- ключи ПАРОЙ: `doc:gen:<id>` (основной) + `doc:gen:<id>:r` (парный, payload `{rerun:true}`);
  одноимённая постановка схлопывается об живой джоб (partial unique движка);
- `JobsService.enqueue` теперь возвращает `{inserted}` (число строк $executeRaw при
  ON CONFLICT DO NOTHING) — `requestGenerate` по `false` ставит ПАРНЫЙ ключ с runAt +1.5с:
  живой джоб мог прочитать данные ДО правки;
- обработчик: `contentSnapshot` (title/number/subject/counterparty*/templateId/fields/
  formFields/builderDoc — ВСЕ входы рендера со строки; новое поле рендера ОБЯЗАНО попасть сюда) →
  перед replaceContent сверка снимка (устаревшие байты НЕ пишутся) → в хвосте `rerunIfStale`
  перезаказывает ПАРНЫМ ключом (своим нельзя — сам ещё executing, постановка схлопнется);
  сходится, как только правки прекращаются;
- бэкофф generate=3с (maxAttempts 6), pdf=3с (maxAttempts 8 — окно ожидания Collabora ≈6 мин);
- `title` добавлен в триггеры пересборки (печатается в {Документ.Название} — раньше rename
  оставлял старое название в байтах);
- та же дисциплина в builder-ветке `snapshotPdf` (она тоже переписывает файл).

**Веб:** `OrgDocumentDto.rebuilding?` (считает `isRebuilding` — тот же предикат, что страж);
карточка: `refetchInterval: (q) => q.state.data?.rebuilding ? 2500 : false` + disabled
у «Отправить на маршрут»; модалка «Отправить контрагенту» привязывает контрагента ПРИ ВЫБОРЕ
(mutation на onChange Select), а не первой строкой send — раньше send упирался в собственный
только что поставленный PATCH-джоб почти гарантированно; canSend ждёт `bound && !rebuilding`.

**Остаточный риск (осознанный):** ms-гонка «оба джоба закончили финальную сверку до коммита
правки, а её enqueue застал обоих ещё executing» — теоретическая, самолечится следующим
касанием; строго лучше прежнего (терялось рутинно при автосейве).

## 2. Стоп-кран рекурсии в core/sign

Кольцо `documents.get → summaryForRef → canViewRequest → provider.canView → documents.get`
(тихое: витки асинхронные, каждый в БД, висит до HTTP-таймаута). Точка закрыта флагом
`viewAuthorized` у единственного вызова, но класс был открыт. Теперь в `canViewRequest` —
`AsyncLocalStorage<Set<key>>`: повторный вход с тем же `refType:refId:userId` внутри одной
async-цепочки → error-лог + fail-closed false (кольцо рвётся на первом витке, внешний ответ
остаётся верным: canView успевает вернуть true).

## Сьюты
verify-doc-builder (tries ужаты 90→30 — теперь трипваер), verify-documents (повторная отправка
после правки названия — waitFor: title-триггер новый), verify-edo, verify-sign, verify-jobs 38/0,
verify-share-links, verify-chatter 68/0, verify-notify-jobs 11/0 — все зелёные.

## Ловушка
Мелкий остаток `variantName` (files.service): незнакомый MIME варианта → `.bin` → чёрный список
исполняемых на инжесте — новый вид варианта повторит аварию «Исполняемые файлы запрещены».
