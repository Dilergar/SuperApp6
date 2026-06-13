import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis-io.adapter';
import { validateEnv } from './shared/config/env.validation';

// Защитная сеть: одна «забытая» асинхронная ошибка (unhandled rejection) в новых
// версиях Node роняет ВЕСЬ процесс. Логируем и продолжаем работать — сервер не падает
// из-за фонового сбоя (фоновой задачи, веб-хука, листенера); причина видна в логе.
const fatalLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  fatalLogger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  fatalLogger.error(`Uncaught exception: ${err instanceof Error ? err.stack : String(err)}`);
});

async function bootstrap() {
  // Fail fast on a broken .env (unknown NODE_ENV, missing DATABASE_URL/JWT_SECRET,
  // production without REDIS_URL) — BEFORE any module starts half-working.
  validateEnv();

  const app = await NestFactory.create(AppModule);

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

  // Global prefix
  app.setGlobalPrefix('api');

  // CORS — allow mobile and web apps
  app.enableCors({
    origin: [
      'http://localhost:3000', // Next.js web
      'http://localhost:8081', // Expo dev
    ],
    credentials: true,
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
  // NODE_ENV must not expose the API map; env validation already whitelists the values).
  if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    const config = new DocumentBuilder()
      .setTitle('SuperApp6 API')
      .setDescription('API для SuperApp6 — одно приложение для всего')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Realtime (messenger): socket.io with a Redis adapter so room broadcasts reach
  // connected clients across all API instances.
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
