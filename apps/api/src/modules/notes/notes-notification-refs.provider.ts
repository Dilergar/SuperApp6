import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { noteUrl } from './notes-dto';

/** Заметка: адресатов (шеринг, упоминания) уже отфильтровал продюсер по праву видеть; deep link — по пространству. */
@Injectable()
export class NotesNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('note', {
      canViewMany: async (userIds) => userIds,
      href: (ref, ctx) => (ctx.workspaceId ? noteUrl({ ownerType: 'workspace', ownerId: ctx.workspaceId }, ref.id) : `/notes/${ref.id}`),
      richCardType: 'note',
    });
  }
}
