import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PlatformPolicyDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { PLATFORM_POLICY_ID } from './platform.constants';

type Tx = Prisma.TransactionClient;

interface PolicyJson {
  dualControlEnabled?: boolean;
}

/** Политика кабинета — одна строка JSON. `dualControlEnabled: false` по умолчанию; меняется командой `platform.policy.set`. */
@Injectable()
export class PlatformPolicyService {
  constructor(private readonly db: DatabaseService) {}

  async get(tx: Tx | DatabaseService = this.db): Promise<PlatformPolicyDto> {
    const row = await tx.platformPolicy.findUnique({ where: { id: PLATFORM_POLICY_ID } });
    const json = ((row?.policy as PolicyJson | null) ?? {}) as PolicyJson;
    return {
      dualControlEnabled: json.dualControlEnabled === true,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async dualControlEnabled(tx?: Tx): Promise<boolean> {
    return (await this.get(tx)).dualControlEnabled;
  }

  async set(tx: Tx, actorId: string, patch: PolicyJson): Promise<{ before: PlatformPolicyDto; after: PlatformPolicyDto }> {
    const before = await this.get(tx);
    const merged: PolicyJson = { dualControlEnabled: patch.dualControlEnabled ?? before.dualControlEnabled };
    await tx.platformPolicy.upsert({
      where: { id: PLATFORM_POLICY_ID },
      create: { id: PLATFORM_POLICY_ID, policy: merged as Prisma.InputJsonObject, updatedBy: actorId },
      update: { policy: merged as Prisma.InputJsonObject, updatedBy: actorId },
    });
    return { before, after: await this.get(tx) };
  }
}
