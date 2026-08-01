import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Transform, pipeline } from 'stream';
import type { NextFunction, Request, Response } from 'express';
import { FILE_LIMITS } from '@superapp/shared';
import { DocsTokenService } from './docs-token.service';

const logger = new Logger('WopiRawBody');

/** Проверка подписи не имеет зависимостей — экземпляр создаётся прямо здесь, вне DI */
const tokens = new DocsTokenService();

export interface WopiRawBody {
  /** Временный файл с телом запроса (потребляется движком файлов) */
  path: string;
  size: number;
}

/** Тот же tmp-каталог, что у загрузок: один том с local-хранилищем → rename дёшев */
function tmpDir(): string {
  const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT ?? './storage');
  const dir = path.join(root, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Тело PutFile — это БАЙТЫ ДОКУМЕНТА, а не JSON: принимаем их потоком на диск, минуя
 * body-parser (десятки мегабайт в памяти на каждое автосохранение — прямой путь к OOM),
 * и кладём путь в req.wopiBody. Навешивается точечно на POST /api/wopi/files/*​/contents
 * в main.ts — ПОСЛЕ алиаса /api/v1→/api (один use покрывает оба префикса) и ДО listen,
 * ровно как express.raw для вебхука LiveKit.
 */
export function wopiRawBodyMiddleware(maxBytes = FILE_LIMITS.apiSingleRequestMax) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || !/\/contents(\?|$)/.test(req.originalUrl)) {
      next();
      return;
    }
    // Ранний отказ по объявленной длине — не тянем мегабайты, чтобы отвергнуть в конце.
    // Потолок здесь — потолок ОДНОГО запроса с байтами (apiSingleRequestMax), а не лимит
    // профиля «document»: документом становится файл, приехавший вложением чата (профиль
    // на 200 МБ), и потолок в 50 МБ означал бы 413 на каждое автосохранение — человек час
    // правит и теряет работу. Абсолютный hardMaxSize (2 ГБ, профиль Диска) сюда тоже не
    // годится: такой объём в одном запросе — это временный файл и проксь на два гигабайта.
    // Точный лимит по профилю КОНКРЕТНОГО файла проверит replaceContent движка файлов.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.status(413).end();
      return;
    }

    // Подпись токена проверяем ДО того, как начать писать байты на диск. Мидлварь живёт
    // на уровне Express, то есть ДО guard'ов Nest, а троттлер на WOPI-контроллере снят
    // (у контейнера редактора один IP на всех) — без этой проверки любой желающий, не
    // предъявляя ничего, заливал бы нам сотни мегабайт в тот же том, где лежит
    // хранилище файлов, и клал бы вместе с редактором все загрузки платформы.
    // Неверный токен НЕ отвечаем сами: пусть контроллер вернёт свой 401/404 (движок
    // может быть вовсе выключен) — мы лишь не читаем тело.
    const token = new URL(req.originalUrl, 'http://local').searchParams.get('access_token');
    if (!tokens.verify(token).ok) {
      next();
      return;
    }

    const file = path.join(tmpDir(), `wopi-${randomUUID()}`);
    // Страховка от протечки временных файлов: контроллер прибирает свой путь сам, но
    // до контроллера запрос может и не дойти (не нашлась ручка, отвалился гвард,
    // клиент оборвал соединение). Unlink идемпотентен: к этому моменту байты обычно
    // уже переехали в хранилище переименованием, и здесь просто ENOENT.
    res.on('close', () => void fs.promises.unlink(file).catch(() => undefined));
    const out = fs.createWriteStream(file);
    let size = 0;
    let tooLarge = false;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          tooLarge = true;
          cb(new Error('payload too large'));
          return;
        }
        cb(null, chunk);
      },
    });

    pipeline(req, counter, out, (err) => {
      if (err) {
        fs.promises.unlink(file).catch(() => undefined);
        if (tooLarge) {
          res.status(413).end();
          return;
        }
        // Обрыв соединения на приёме тела — это не наша ошибка и не 500: клиент уйдёт
        // в ретрай сам, а лишний стек в логе только шумит.
        logger.warn(`приём тела прерван: ${err.message}`);
        if (!res.headersSent) res.status(400).end();
        return;
      }
      const request = req as Request & { wopiBody?: WopiRawBody; _body?: boolean };
      request.wopiBody = { path: file, size };
      // Тело уже вычитано нами. Без этой метки body-parser Nest'а полезет читать
      // тот же поток дальше по цепочке и упадёт «stream is not readable» (какой
      // Content-Type пришлёт редактор — не наше дело; COOL шлёт octet-stream, но
      // полагаться на это нельзя). `_body` — штатный флаг «уже разобрано» body-parser.
      request._body = true;
      request.body = {};
      next();
    });
  };
}
