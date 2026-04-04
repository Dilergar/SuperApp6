import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { normalizePhone } from '@superapp/shared';

@Injectable()
export class CirclesService {
  constructor(private db: DatabaseService) {}

  /** Get all circles for a user */
  async getCircles(userId: string) {
    return this.db.circle.findMany({
      where: { ownerId: userId },
      include: {
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Create a new circle */
  async createCircle(userId: string, data: { name: string; icon?: string; color?: string }) {
    return this.db.circle.create({
      data: {
        ownerId: userId,
        name: data.name,
        icon: data.icon,
        color: data.color,
      },
      include: {
        _count: { select: { members: true } },
      },
    });
  }

  /** Get circle with all members */
  async getCircle(userId: string, circleId: string) {
    const circle = await this.db.circle.findUnique({
      where: { id: circleId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                avatar: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!circle) {
      throw new NotFoundException('Окружение не найдено');
    }

    if (circle.ownerId !== userId) {
      throw new ForbiddenException('Нет доступа к этому окружению');
    }

    return circle;
  }

  /** Add member to circle */
  async addMember(
    userId: string,
    circleId: string,
    data: { contactPhone: string; contactName: string; role: string },
  ) {
    // Verify circle ownership
    const circle = await this.db.circle.findUnique({ where: { id: circleId } });
    if (!circle || circle.ownerId !== userId) {
      throw new ForbiddenException('Нет доступа к этому окружению');
    }

    const normalizedPhone = normalizePhone(data.contactPhone);

    // Check if user exists on platform
    const existingUser = await this.db.user.findUnique({
      where: { phone: normalizedPhone },
      select: { id: true },
    });

    return this.db.circleMember.create({
      data: {
        circleId,
        contactPhone: normalizedPhone,
        contactName: data.contactName,
        role: data.role,
        userId: existingUser?.id,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true,
          },
        },
      },
    });
  }

  /** Update member role/name */
  async updateMember(
    userId: string,
    memberId: string,
    data: { contactName?: string; role?: string },
  ) {
    const member = await this.db.circleMember.findUnique({
      where: { id: memberId },
      include: { circle: { select: { ownerId: true } } },
    });

    if (!member || member.circle.ownerId !== userId) {
      throw new ForbiddenException('Нет доступа');
    }

    return this.db.circleMember.update({
      where: { id: memberId },
      data,
    });
  }

  /** Remove member from circle */
  async removeMember(userId: string, memberId: string) {
    const member = await this.db.circleMember.findUnique({
      where: { id: memberId },
      include: { circle: { select: { ownerId: true } } },
    });

    if (!member || member.circle.ownerId !== userId) {
      throw new ForbiddenException('Нет доступа');
    }

    await this.db.circleMember.delete({ where: { id: memberId } });
  }

  /** Delete circle */
  async deleteCircle(userId: string, circleId: string) {
    const circle = await this.db.circle.findUnique({ where: { id: circleId } });
    if (!circle || circle.ownerId !== userId) {
      throw new ForbiddenException('Нет доступа к этому окружению');
    }

    await this.db.circle.delete({ where: { id: circleId } });
  }

  /**
   * Get all contacts from all circles (for task assignment etc.)
   * Returns unique contacts across all user's circles.
   */
  async getAllContacts(userId: string) {
    const members = await this.db.circleMember.findMany({
      where: { circle: { ownerId: userId } },
      include: {
        circle: { select: { name: true } },
        user: {
          select: { id: true, firstName: true, lastName: true, avatar: true },
        },
      },
      orderBy: { contactName: 'asc' },
    });

    return members;
  }
}
