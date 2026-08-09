import { Body, Controller, ForbiddenException, Injectable, OnModuleInit, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { approvalStepInputSchema } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ApprovalsService } from './approvals.service';
import { ApprovalsRegistry } from './approvals.registry';

/** Тип предмета дев-полигона. Живёт только при NODE_ENV=development/test. */
export const APPROVAL_DEV_REF_TYPE = 'approval_dev';

/**
 * Дев-полигон движка согласований (прецедент — `jobs.dev.echo` у движка джобов).
 *
 * Нужен, чтобы Этап 1 можно было проверить сьютом ДО того, как появится первый
 * настоящий потребитель: иначе движок пришлось бы принимать «на веру» вместе с
 * сервисом Документов, и любая ошибка модели всплыла бы уже внутри чужого кода.
 *
 * Предметы держим в памяти процесса: у полигона нет и не должно быть своей таблицы.
 */
@Injectable()
export class ApprovalsDevProvider implements OnModuleInit {
  /** refId → контекст предмета (объявляется дев-ручкой перед созданием заявки) */
  private readonly subjects = new Map<string, { title: string; workspaceId: string | null; sha?: string | null }>();
  /** originRef → чем закончилась заявка (сьют читает через дев-ручку) */
  private readonly outcomes = new Map<string, string>();

  constructor(private readonly registry: ApprovalsRegistry) {}

  onModuleInit(): void {
    if (!isDevEnv()) return;
    // Ведущий-полигон: без него путь «заявка ведётся снаружи» пришлось бы
    // проверять только внутри Процессов, то есть уже вместе с чужим кодом.
    this.registry.registerOrigin(APPROVAL_DEV_REF_TYPE, {
      onResolved: async (originRef, outcome) => {
        this.outcomes.set(originRef, outcome);
      },
    });
    this.registry.register(APPROVAL_DEV_REF_TYPE, {
      describeForCreate: async (_userId, refId) => {
        const s = this.subjects.get(refId);
        return s ? { title: s.title, workspaceId: s.workspaceId, contentSha256: s.sha ?? null } : null;
      },
      describeRef: async (refId) => {
        const s = this.subjects.get(refId);
        return s ? { title: s.title, icon: 'file', href: `/dev/approvals/${refId}` } : null;
      },
      canView: async () => false, // посторонний не видит — проверяется сьютом
    });
  }

  declare(refId: string, subject: { title: string; workspaceId: string | null; sha?: string | null }): void {
    this.subjects.set(refId, subject);
  }

  outcomeOf(originRef: string): string | null {
    return this.outcomes.get(originRef) ?? null;
  }
}

const devCreateSchema = z
  .object({
    refId: z.string().uuid(),
    title: z.string().min(1).max(200),
    workspaceId: z.string().uuid().nullable().optional(),
    sha: z.string().max(64).nullable().optional(),
    /** Ссылка «кто ведёт» — сьют проверяет ею идемпотентность повторного вызова */
    originRef: z.string().min(1).max(200).optional(),
    steps: z.array(approvalStepInputSchema).min(1),
  })
  .strict();

@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('approvals/dev')
export class ApprovalsDevController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly provider: ApprovalsDevProvider,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw new ForbiddenException('Дев-полигон доступен только в development');
  }

  @Post('request')
  @ApiOperation({ summary: 'Дев-полигон: объявить предмет и завести на него заявку (только development)' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = devCreateSchema.parse(body ?? {});
    this.provider.declare(dto.refId, {
      title: dto.title,
      workspaceId: dto.workspaceId ?? null,
      sha: dto.sha ?? null,
    });
    const data = await this.approvals.create(
      user.sub,
      {
        refType: APPROVAL_DEV_REF_TYPE,
        refId: dto.refId,
        steps: dto.steps,
      },
      dto.originRef ? { type: APPROVAL_DEV_REF_TYPE, ref: dto.originRef } : undefined,
    );
    return { success: true, data };
  }

  /**
   * Поднять шагу требование подписи. В настоящей жизни это делает потребитель
   * при сборке маршрута (вид документа диктует уровень), но проверить гвард
   * «обычный клик не закрывает подписной шаг» надо ДО появления потребителя.
   */
  @Post('step/:stepId/require-signature')
  @ApiOperation({ summary: 'Дев-полигон: потребовать от шага подпись (только development)' })
  async requireSignature(@Param('stepId') stepId: string, @Body() body: unknown) {
    this.assertDev();
    const { kind } = z
      .object({ kind: z.enum(['sms', 'ecp']).nullable() })
      .strict()
      .parse(body ?? {});
    await this.approvals.setStepSignatureRequirement(null, [stepId], kind);
    return { success: true, data: { stepId, kind } };
  }

  @Post('outcome')
  @ApiOperation({ summary: 'Дев-полигон: чем закончилась заявка по ссылке ведущего (только development)' })
  async outcome(@Body() body: unknown) {
    this.assertDev();
    const { originRef } = z.object({ originRef: z.string().min(1) }).strict().parse(body ?? {});
    return { success: true, data: { outcome: this.provider.outcomeOf(originRef) } };
  }
}
