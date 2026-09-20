import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis-io.adapter';
import { validateEnv } from './shared/config/env.validation';
import { wopiRawBodyMiddleware } from './core/docs/wopi-raw-body.middleware';
import { DocsTokenService } from './core/docs/docs-token.service';
import { isAllowedWebOrigin, webOrigins } from './shared/config/web-origins';
import { IDEMPOTENCY_EXPOSED_HEADERS, IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_RE } from '@superapp/shared';

// Защитная сеть: одна «забытая» асинхронная ошибка (unhandled rejection) в новых
// версиях Node роняет ВЕСЬ процесс. Логируем и продолжаем работать — сервер не падает
// из-за фонового сбоя (фоновой задачи, веб-хука, листенера); причина видна в логе.
const fatalLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  fatalLogger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  // uncaughtException — в отличие от rejection — оставляет процесс в неопределённом
  // состоянии (полуоткрытые сокеты/стримы, повисшие локи). Логируем и уходим под
  // рестарт супервизора: короткая пауза даёт логу доехать.
  fatalLogger.error(`Uncaught exception: ${err instanceof Error ? err.stack : String(err)}`);
  setTimeout(() => process.exit(1), 200);
});

/**
 * В production процесс не должен уметь отдавать свою память наружу: `--inspect`
 * открывает отладчик с чтением heap (там распакованные KEK и DEK движка ключей),
 * `--heapsnapshot-signal`/`--heapsnapshot-near-heap-limit` пишут heap на диск по сигналу,
 * `--report-on-signal` — диагностический отчёт. Core dump выключает ОС (`ulimit -c 0`
 * в юните сервиса) — это правило docs/security.md, здесь проверяется то, что видно
 * процессу. Fail-closed: флаг найден → бут не поднимается.
 */
function assertNoDebugFlagsInProduction(): void {
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') return;
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].filter(Boolean);
  const banned = flags.filter((f) => /^--(inspect|inspect-brk|inspect-port|heapsnapshot-signal|heapsnapshot-near-heap-limit|report-on-signal|report-on-fatalerror|cpu-prof|heap-prof)(=|$)/.test(f));
  if (banned.length) {
    fatalLogger.error(`refusing to start in production with memory-exposing flags: ${banned.join(' ')} (see docs/security.md)`);
    process.exit(1);
  }
}

async function bootstrap() {
  // Fail fast on a broken .env (unknown NODE_ENV, missing DATABASE_URL, production
  // without REDIS_URL or KEYS_ROOT_KEY_FILE) — BEFORE any module starts half-working.
  validateEnv();
  assertNoDebugFlagsInProduction();

  const app = await NestFactory.create(AppModule);

  // Доверенные прокси. Пока это не настроено, Express ИГНОРИРУЕТ X-Forwarded-For, и
  // req.ip = адрес сокета. Именно так и надо: любой клиент может написать в этот
  // заголовок что угодно, и всё, что считает «по IP» (троттлер платформы, IP-эшелоны
  // движка подтверждений — а это деньги на SMS), обнулялось бы случайной строкой в
  // запросе. За балансировщиком выставьте TRUST_PROXY в число прокси-хопов (обычно 1)
  // или в список подсетей — тогда Express возьмёт из XFF ровно столько, сколько мы
  // объявили доверенным, и подделать клиентский IP снаружи станет нельзя.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const hops = Number(trustProxy);
    app.getHttpAdapter().getInstance().set('trust proxy', Number.isFinite(hops) ? hops : trustProxy);
  }

  // Graceful shutdown (движок джобов + хвост блока 7): без этого Nest НЕ зовёт
  // onModuleDestroy на SIGTERM/SIGINT — docker stop убивал бы in-flight джобы без
  // дренажа (аренды их вернули бы, но зачем терять работу), а Redis/EventBus не
  // закрывали соединения. Дренаж воркера ограничен JOB_LIMITS.shutdownDrainMs.
  app.enableShutdownHooks();

  // API versioning (arch-review block 7): /api/v1 — КАНОНИЧЕСКИЙ префикс. Установленные
  // мобильные сборки живут у людей месяцами и пиняются на v1 — будущий ломающий v2
  // сможет сосуществовать. /api (без версии) остаётся legacy-алиасом для совместимости
  // (verify-скрипты, старые ссылки); web/mobile клиенты уже ходят на /api/v1.
  app.use((req: { url: string }, _res: unknown, next: () => void) => {
    if (req.url === '/api/v1' || req.url.startsWith('/api/v1/')) {
      req.url = '/api' + req.url.slice('/api/v1'.length);
    }
    next();
  });

  // Вебхук LiveKit (core/calls): подпись проверяется по СЫРОМУ телу (WebhookReceiver),
  // поэтому точечный raw-парсер только на этот путь — глобальный json Nest вешает позже
  // (в app.listen) и пропустит уже распарсенное. Alias /api/v1→/api отработал выше,
  // так что один use покрывает оба префикса.
  // Потолок тела занижен до 64kb: вебхуки LiveKit — маленькие JSON'ы (<10kb), а эндпоинт
  // @Public (без JWT) — узкий лимит режет DoS-амплификацию на неаутентифицированном пути.
  app.use('/api/calls/livekit/webhook', express.raw({ type: () => true, limit: '64kb' }));

  // PutFile движка документов (core/docs): тело — БАЙТЫ документа, а не JSON. Принимаем
  // потоком на диск (десятки мегабайт в памяти на каждое автосохранение = OOM) до того,
  // как до тела доберётся body-parser. Alias /api/v1→/api отработал выше — один use
  // покрывает оба префикса, как у вебхука LiveKit.
  // Верификатор — из DI: подпись WOPI-токена проверяет keystore (core/keys), не константа.
  const docsTokens = app.get(DocsTokenService);
  app.use('/api/wopi/files', wopiRawBodyMiddleware(async (token) => (await docsTokens.verify(token)).ok));

  // Заголовки безопасности. API отдаёт JSON и байты файлов, HTML приложения рендерит
  // веб — поэтому основной CSP живёт в apps/web/next.config.ts, а здесь берём остальное
  // (nosniff, frameguard, Referrer-Policy, HSTS, скрытие X-Powered-By).
  app.use(
    helmet({
      // CSP выключен намеренно: (1) API не рендерит HTML приложения; (2) дефолтный CSP
      // helmet ломает inline-скрипты Swagger UI (/api/docs, поднимается в development).
      contentSecurityPolicy: false,
      // КРИТИЧНО: по умолчанию helmet ставит CORP same-origin, а веб (:3000) грузит
      // аватарки, фото товаров, вложения чата, голосовые и записи звонков с API (:3001).
      // same-origin убил бы всю медиа-выдачу на другом порту/домене.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Байты файлов иногда ОБЯЗАНЫ грузиться во фрейме: PDF-отпечаток документа на гостевой
  // странице /s/<токен> рисует встроенный просмотрщик браузера, а он живёт только в iframe.
  // helmet ставит на КАЖДЫЙ ответ X-Frame-Options: SAMEORIGIN, и раз веб с API стоят на
  // разных портах (в проде — на разных доменах), браузер такой iframe молча блокировал:
  // в сети 200 OK с пометкой net::ERR_BLOCKED_BY_RESPONSE, на экране — пустая рамка.
  // Снимать frameguard глобально нельзя — он закрывает от кликджекинга остальной API,
  // у которого есть одно-кликовые действия с деньгами. Поэтому ТОЧЕЧНО на маршрутах
  // выдачи байтов грубый XFO меняется на адресный frame-ancestors: тот же приём и та же
  // причина, что у CORP выше. Список origin'ов — из WEB_URL (в dev к нему добавляется
  // второй адрес того же веба, как в CORS).
  const frameAncestors = ["'self'", ...webOrigins()].join(' ');
  const FRAMEABLE_BYTE_PATHS = ['/api/files/raw/', '/api/public-files/'];
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (FRAMEABLE_BYTE_PATHS.some((p) => req.path.startsWith(p))) {
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
    }
    next();
  });

  // Global prefix
  // JWKS платформы (core/keys) живёт по стандартному адресу вне префикса: внешние
  // верификаторы ищут `/.well-known/jwks.json` у корня хоста (RFC 8615).
  // Метрики Prometheus — тоже у корня (`/metrics`, гейт METRICS_TOKEN, shared/metrics).
  app.setGlobalPrefix('api', { exclude: ['.well-known/jwks.json', 'metrics'] });

  // CORS — веб и мобильный клиент. Список — общий с сокетом и frame-ancestors
  // (shared/config/web-origins.ts); прод-адрес приходит из WEB_URL.
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, isAllowedWebOrigin(origin)),
    credentials: true,
    // Ответы движка идемпотентности читает КЛИЕНТСКИЙ КОД в браузере, а веб и API
    // стоят на разных портах (в проде — на разных доменах). Без этого списка браузер
    // просто не отдаёт заголовки скрипту, и авто-повтор терял бы подсказки.
    exposedHeaders: [...IDEMPOTENCY_EXPOSED_HEADERS],
  });

  // Validation pipe — auto-validate all incoming DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger API docs — ONLY in explicit development (secure-by-default: an unexpected
  // OR MISSING NODE_ENV must not expose the API map; env validation whitelists values,
  // but «забыли переменную в контейнере» не должно открывать карту API).
  if (process.env.NODE_ENV === 'development') {
    const config = new DocumentBuilder()
      .setTitle('SuperApp6 API')
      .setDescription('The SuperApp6 API — one app for everything')
      .setVersion('0.1.0')
      .addBearerAuth()
      // Ключ повтора (core/idempotency) — глобальный заголовок: интегратор видит его
      // на КАЖДОЙ мутации, а не ищет по документации
      .addGlobalParameters({
        name: IDEMPOTENCY_KEY_HEADER,
        in: 'header',
        required: false,
        description: 'Repeat-protection key: the same key returns the first outcome instead of repeating the effect',
        schema: { type: 'string', pattern: IDEMPOTENCY_KEY_RE.source },
      })
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Realtime (core/realtime, namespace /realtime): socket.io с Redis-адаптером — рассылка
  // в комнаты доходит до клиентов на всех инстансах API.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 SuperApp6 API running on http://localhost:${port}`);
  console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
