import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  HIDDEN,
  isGuardMarker,
  type ContactUserCard,
  type Guarded,
  type SocialLinks,
  type VisibilityPreviewAs,
} from '@superapp/shared';
import type { Prisma } from '@prisma/client';
import { VisibilityTypeRegistry } from '../visibility/visibility.registry';
import { VisibilityService, markShaped, type ShapeInput, type ShapedValues, type VisibilityViewer } from '../visibility/visibility.service';

/** Колонки карточки человека — единый select для всех, кто её рисует (Окружение, ростер, находимость). */
export const USER_CARD_SELECT = {
  id: true,
  phone: true,
  firstName: true,
  lastName: true,
  avatar: true,
  dateOfBirth: true,
  bio: true,
  city: true,
  email: true,
  maritalStatus: true,
  socialLinks: true,
} as const satisfies Prisma.UserSelect;

export type UserCardRow = Prisma.UserGetPayload<{ select: typeof USER_CARD_SELECT }>;

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function calcAge(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Карточка человека (тип `user.card` движка видимости) — ОДНА проекция на все поверхности:
 * Окружение, ростер организации, находимость по номеру, пре-линк карточка приглашений,
 * предпросмотр «как видит». Поля — ЛИЧНЫЕ (решает только сам человек); движок возвращает по
 * каждому `Guarded`, здесь они собираются в `ContactUserCard`.
 *
 * Дата рождения — два поля реестра (день-месяц и год настраиваются раздельно, как в Graph
 * API), на проводе — одно `dateOfBirth`: целиком / маска `--MM-DD` / маска `YYYY` / скрыто.
 * Возраст — производное года: виден ровно тогда, когда виден год.
 */
@Injectable()
export class UserCardService implements OnModuleInit {
  constructor(
    private readonly visibility: VisibilityService,
    private readonly types: VisibilityTypeRegistry,
  ) {}

  onModuleInit(): void {
    // Личные поля не раскрываются (маска знакомому — «скрыт ≠ недостижим», а не замок):
    // провайдер нужен реестру (страж бута), раскрытие по нему всегда 404
    this.types.register('user.card', { loadForReveal: async () => null });
  }

  private input(row: UserCardRow, extra: { presence?: unknown } = {}): ShapeInput {
    const dob = iso(row.dateOfBirth);
    return {
      ref: { recordId: row.id, subjectId: row.id, workspaceId: null },
      values: {
        firstName: row.firstName,
        lastName: row.lastName,
        avatar: row.avatar,
        phone: row.phone,
        email: row.email,
        birthDayMonth: dob,
        birthYear: dob,
        maritalStatus: row.maritalStatus,
        socialLinks: row.socialLinks as SocialLinks | null,
        city: row.city,
        bio: row.bio,
        presence: extra.presence ?? true,
      },
    };
  }

  private assemble(row: UserCardRow, s: ShapedValues): ContactUserCard {
    const dm = s.birthDayMonth;
    const yr = s.birthYear;
    let dateOfBirth: Guarded<string | null>;
    if (!isGuardMarker(dm) && !isGuardMarker(yr)) dateOfBirth = (dm as string | null) ?? null;
    else if (!isGuardMarker(dm)) dateOfBirth = dm === null ? null : this.visibility.maskValue('date_month_day', dm);
    else if (!isGuardMarker(yr)) dateOfBirth = yr === null ? null : this.visibility.maskValue('date_year', yr);
    else dateOfBirth = HIDDEN;
    const age: Guarded<number | null> = isGuardMarker(yr) ? HIDDEN : row.dateOfBirth ? calcAge(row.dateOfBirth) : null;
    const presence = s.presence;
    return markShaped({
      id: row.id,
      firstName: row.firstName,
      lastName: s.lastName as Guarded<string | null>,
      avatar: s.avatar as Guarded<string | null>,
      phone: s.phone as Guarded<string>,
      email: s.email as Guarded<string | null>,
      dateOfBirth,
      age,
      maritalStatus: s.maritalStatus as Guarded<string | null>,
      socialLinks: s.socialLinks as Guarded<SocialLinks | null>,
      city: s.city as Guarded<string | null>,
      bio: s.bio as Guarded<string | null>,
      showOnlineStatus: isGuardMarker(presence) ? presence : true,
    });
  }

  /** Карточки глазами зрителя — пакетом (политики субъектов и связи — один раз на пачку). */
  async cards(viewer: VisibilityViewer, rows: readonly UserCardRow[]): Promise<ContactUserCard[]> {
    if (!rows.length) return [];
    const shaped = await this.visibility.shape(viewer, 'user.card', rows.map((r) => this.input(r)));
    return rows.map((r, i) => this.assemble(r, shaped[i]!));
  }

  async card(viewer: VisibilityViewer, row: UserCardRow): Promise<ContactUserCard> {
    return (await this.cards(viewer, [row]))[0]!;
  }

  /** Своя карточка глазами синтетического зрителя («Моя карточка и видимость» → «Как видит»). */
  async preview(row: UserCardRow, as: VisibilityPreviewAs): Promise<ContactUserCard> {
    const input = this.input(row);
    const shaped = await this.visibility.previewPersonal(row.id, 'user.card', { kind: as.kind, id: 'id' in as ? as.id : 'workspaceId' in as ? as.workspaceId : null }, input.values);
    return this.assemble(row, shaped);
  }
}
