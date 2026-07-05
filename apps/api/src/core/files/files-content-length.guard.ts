import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FILE_PROFILES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';

/**
 * Ранний 413 на PUT /files/:id/content: гард выполняется ДО FileInterceptor'а
 * (guards → interceptors), т.е. до того, как multer примет хоть байт — не пишем
 * на диск заведомо превышающие лимит профиля тела.
 */
@Injectable()
export class FilesContentLengthGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ params?: { id?: string }; headers: Record<string, string | undefined>; user?: { sub?: string } }>();
    const fileId = req.params?.id;
    if (!fileId) return true;

    const row = await this.db.fileObject.findUnique({
      where: { id: fileId },
      select: { profile: true, status: true, uploaderId: true, uploadId: true },
    });
    if (!row || row.status === 'deleted') throw new NotFoundException('Файл не найден');
    if (row.status !== 'uploading') throw new ConflictException('Файл уже завершён');
    if (req.user?.sub && row.uploaderId !== req.user.sub) {
      throw new ForbiddenException('Загрузку продолжает только её автор');
    }

    const spec = FILE_PROFILES[row.profile] ?? FILE_PROFILES.generic;
    const contentLength = Number(req.headers['content-length'] ?? 0);
    // Требуем Content-Length: без него (chunked) ранний 413 не сработает и multer
    // напишет на диск до глобального hardMaxSize (200 МБ) даже для 5-МБ профиля.
    // Легитимные клиенты (браузер/axios с multipart/form-data) его всегда шлют.
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      throw new HttpException('Требуется заголовок Content-Length', HttpStatus.LENGTH_REQUIRED);
    }
    // +1 МБ на служебные части multipart/form-data
    if (contentLength > spec.maxSize + 1024 * 1024) {
      throw new PayloadTooLargeException('Файл больше лимита профиля');
    }
    return true;
  }
}
