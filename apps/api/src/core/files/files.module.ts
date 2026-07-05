import { Global, Module } from '@nestjs/common';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { PublicFilesController } from './public-files.controller';
import { FilesUrlService } from './files-url.service';
import { FilesRefRegistry } from './files-ref.registry';
import { FilesScanHook } from './files-scan.hook';
import { FilesPipelineService } from './files-pipeline.service';
import { FilesCron } from './files.cron';
import { FilesContentLengthGuard } from './files-content-length.guard';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage-driver';
import { LocalStorageDriver } from './storage/local.driver';
import { S3StorageDriver } from './storage/s3.driver';

/**
 * Files Engine (core/files) — 6-й платформенный движок: хранение/загрузка/раздача
 * файлов для всех сервисов. @Global: потребители инжектят FilesService (linkFile)
 * и FilesRefRegistry (регистрация refType-резолвера в onModuleInit) без импорта модуля.
 * Байт-стор — драйвер по env FILES_DRIVER: local (диск, dev-дефолт) | s3 (SeaweedFS/облако).
 */
@Global()
@Module({
  controllers: [FilesController, PublicFilesController],
  providers: [
    {
      provide: STORAGE_DRIVER,
      useFactory: (): StorageDriver =>
        process.env.FILES_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver(),
    },
    FilesUrlService,
    FilesRefRegistry,
    FilesScanHook,
    FilesPipelineService,
    FilesService,
    FilesCron,
    FilesContentLengthGuard,
  ],
  exports: [FilesService, FilesRefRegistry],
})
export class FilesModule {}
