import { z } from 'zod';
import { MESSENGER_LIMITS } from '../constants/messenger';

const noHtml = (s: string) => !/[<>]/.test(s);

export const openDmSchema = z
  .object({
    userId: z.string().uuid(),
  })
  .strict();

export const createGroupSchema = z
  .object({
    name: z
      .string()
      .min(1, 'validation.messenger.titleEmpty')
      .max(MESSENGER_LIMITS.maxGroupNameLength)
      .refine(noHtml, 'validation.contact.badCharacters'),
    memberIds: z.array(z.string().uuid()).max(MESSENGER_LIMITS.maxAddMembersAtOnce),
  })
  .strict();

export const addMembersSchema = z
  .object({
    userIds: z
      .array(z.string().uuid())
      .min(1, 'validation.messenger.pickSomeone')
      .max(MESSENGER_LIMITS.maxAddMembersAtOnce),
  })
  .strict();

export const renameChatSchema = z
  .object({
    title: z
      .string()
      .min(1, 'validation.messenger.titleEmpty')
      .max(MESSENGER_LIMITS.maxGroupNameLength)
      .refine(noHtml, 'validation.contact.badCharacters'),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    content: z
      .string()
      .min(1, 'validation.messenger.messageEmpty')
      .max(MESSENGER_LIMITS.maxMessageLength)
      .refine(noHtml, 'validation.contact.badCharacters'),
    /** Optional id of a message in the same chat to quote (reply). */
    replyToId: z.string().uuid().optional(),
  })
  .strict();

/** POST /messenger/chats/:id/messages/attachments — альбом до 10 файлов + подпись */
export const sendAttachmentsSchema = z
  .object({
    fileIds: z
      .array(z.string().uuid())
      .min(1, 'validation.messenger.pickFile')
      .max(MESSENGER_LIMITS.maxAttachmentsPerMessage, 'validation.messenger.tooManyFiles'),
    caption: z
      .string()
      .max(MESSENGER_LIMITS.maxMessageLength)
      .refine(noHtml, 'validation.contact.badCharacters')
      .optional(),
    replyToId: z.string().uuid().optional(),
  })
  .strict();

export const editMessageSchema = z
  .object({
    content: z
      .string()
      .min(1, 'validation.messenger.messageEmpty')
      .max(MESSENGER_LIMITS.maxMessageLength)
      .refine(noHtml, 'validation.contact.badCharacters'),
  })
  .strict();

export const markReadSchema = z
  .object({
    seq: z.number().int().nonnegative(),
  })
  .strict();

export type OpenDmInput = z.infer<typeof openDmSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type AddMembersInput = z.infer<typeof addMembersSchema>;
export type RenameChatInput = z.infer<typeof renameChatSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type SendAttachmentsInput = z.infer<typeof sendAttachmentsSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
