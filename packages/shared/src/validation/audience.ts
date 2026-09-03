import { z } from 'zod';
import { AUDIENCE_KIND_DEFS, isAudienceAnchor, type AudienceKind } from '../constants/audiences';

const uuid = z.string().uuid();

/**
 * Схема адресата для потребителя с его набором видов. id — uuid, а у относительных
 * видов и `user` дополнительно допускается якорь (`$initiator` / `$subject` / `$self`).
 */
export function audienceRefSchema<K extends AudienceKind>(kinds: readonly K[]) {
  return z
    .object({
      type: z.enum(kinds as unknown as [K, ...K[]]),
      id: z.string().min(1).max(64),
    })
    .strict()
    .superRefine((ref, ctx) => {
      const type = ref.type as unknown as AudienceKind;
      const id = ref.id as unknown as string;
      const anchorOk = AUDIENCE_KIND_DEFS[type].relative || type === 'user';
      if (isAudienceAnchor(id)) {
        if (!anchorOk) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Якорь допустим только у относительных адресатов', path: ['id'] });
        return;
      }
      if (!uuid.safeParse(id).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ожидается идентификатор', path: ['id'] });
      }
    });
}

export function audienceListSchema<K extends AudienceKind>(kinds: readonly K[], max = 50) {
  return z.array(audienceRefSchema(kinds)).min(1).max(max);
}
