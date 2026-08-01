import { Injectable, Logger } from '@nestjs/common';
import type { FileOwnerType } from '@superapp/shared';

/** Куда положить файл, приехавший из чужой сущности */
export interface DrivePlacement {
  ownerType: FileOwnerType;
  ownerId: string;
}

export interface DriveRoutingProvider {
  /**
   * На чей Диск попадает файл, привязанный к этой сущности, — или null, если он не
   * должен попадать никуда.
   *
   * Решение принимает ВЛАДЕЛЕЦ сущности, потому что только он знает её природу:
   * личная переписка двух коллег не должна всплывать на общем диске организации,
   * а вложение задачи организации — должно.
   */
  resolvePlacement(refId: string, actorId: string): Promise<DrivePlacement | null>;
}

/**
 * Реестр маршрутизации файлов на Диск.
 *
 * Направление импорта перевёрнуто намеренно (тот же приём, что у слоёв календаря):
 * Диск не знает ни про чаты, ни про задачи — это МессенджерModule и TasksModule
 * регистрируют, куда складывать свои файлы. Незарегистрированный refType просто не
 * попадает на Диск, и новый сервис подключается одной регистрацией.
 */
@Injectable()
export class DriveRoutingRegistry {
  private readonly logger = new Logger(DriveRoutingRegistry.name);
  private readonly providers = new Map<string, DriveRoutingProvider>();

  register(refType: string, provider: DriveRoutingProvider): void {
    if (this.providers.has(refType)) {
      this.logger.warn(`маршрутизация "${refType}" уже зарегистрирована — перезаписываю`);
    }
    this.providers.set(refType, provider);
  }

  get(refType: string): DriveRoutingProvider | undefined {
    return this.providers.get(refType);
  }

  has(refType: string): boolean {
    return this.providers.has(refType);
  }
}
