import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiError, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { FILE_LIMITS, FILE_PROFILES } from '@superapp/shared';
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
    if (!row || row.status === 'deleted') throw notFound('files.notFound');
    if (row.status !== 'uploading') throw conflict('files.alreadyComplete');
    if (req.user?.sub && row.uploaderId !== req.user.sub) {
      throw forbidden('files.uploaderOnlyContinue');
    }

    const spec = FILE_PROFILES[row.profile] ?? FILE_PROFILES.generic;
    // Это путь ОДНОГО запроса, поэтому потолок здесь — минимум из лимита профиля и
    // потолка одиночного запроса: у профиля Диска maxSize 2 ГБ, но такой файл обязан
    // ехать частями, и принимать его сюда нельзя даже до отсечки multer'а.
    const ceiling = Math.min(spec.maxSize, FILE_LIMITS.apiSingleRequestMax);
    const contentLength = Number(req.headers['content-length'] ?? 0);
    // Требуем Content-Length: без него (chunked) ранний 413 не сработает и multer
    // напишет на диск до apiSingleRequestMax (200 МБ) даже для 5-МБ профиля.
    // Легитимные клиенты (браузер/axios с multipart/form-data) его всегда шлют.
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      throw new ApiError(HttpStatus.LENGTH_REQUIRED, { code: 'files.contentLengthRequired' });
    }
    // +1 МБ на служебные части multipart/form-data
    if (contentLength > ceiling + 1024 * 1024) {
      throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, { code: 'files.tooLargeForProfile' });
    }
    return true;
  }
}
