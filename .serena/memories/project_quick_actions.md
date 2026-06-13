# Quick Actions Engine (core/quick-actions) — Phase 7, 2026-06-01

Reusable registry for the chat action BUTTONS (the composer ＋-menu + a message's corner menu). Same pattern as core/access / core/rich-cards / core/search: one @Global engine, feature services register actions; engine is domain-agnostic (no core→feature import). NOT in chokepoint. User pivoted Phase 7 from slash-commands → buttons; benchmarked Slack Shortcuts (global + message shortcuts → modal) & MS Teams message-actions.

## Principle (locked)
- Form to CREATE something = a MODAL (not a rich card). Rich Card = the RESULT posted into the chat feed (reuse core/rich-cards shareRichCard).
- WHICH buttons appear = the registry (data-driven), filtered by viewer perms + chat context. New service later = +1 registration, messenger untouched.
- Execution reuses each service's EXISTING create API (no domain dup): task.create→POST /tasks, event.create→POST /calendar/events, message.schedule→messenger scheduled endpoints.

## Files (apps/api/src/core/quick-actions/)
- quick-actions.module.ts (@Global; QuickActionRegistry + QuickActionsService + QuickActionsController). Registered in app.module after SearchModule.
- quick-actions.types.ts — QuickActionRegistration extends QuickActionDescriptor + optional isAvailable(ctx:{viewerId,chatId,chatType,parentType,workspaceId}).
- quick-actions.registry.ts — register/all (insertion order = menu order).
- quick-actions.service.ts — listForChat(viewerId,chatId,scope): loads chat, AccessService.can('chat.view') gate, filters registry by scope + isAvailable.
- quick-actions.controller.ts — GET /quick-actions?chatId=&scope=composer|message.

## Shared (@superapp/shared)
types/quick-action.ts (QuickActionDescriptor {key,label,icon,scopes,description?}, QuickActionScope), constants/quick-action.ts (QUICK_ACTION_SCOPES=['composer','message'], SCHEDULED_MESSAGE_LIMITS{minLeadSeconds30,maxHorizonDays365,maxPendingPerChat50}).

## How a NEW service adds a button (the contract)
1. Inject the @Global QuickActionRegistry; in onModuleInit call register({key:'xxx.create', label, icon, scopes:['composer'|'message'], isAvailable?}). (key convention '<domain>.<verb>'.)
2. Web: map the key → a modal component (apps/web/src/app/messenger/QuickActionModals.tsx pattern) that gathers input, calls your existing create API, then shareRichCard(chatId, refType, id) to post the result card. Prefill from the message when opened from the message-menu.
3. Unknown keys are forward-compatible in the web (skipped in message menu / disabled in ＋ menu) — old clients won't break on a new action.

## Reference registrations (Phase 7)
- Tasks: task.create (composer+message; message → prefill description). Calendar: event.create (composer only). Messenger: message.schedule (composer+message; message → prefill text).

## Scheduled messages ("Напомнить", messenger)
ScheduledMessage model + ScheduledMessageService (schedule/list-mine/update/cancel; chat.view gate; lead/horizon/cap validation) + ScheduledMessageCron (EVERY_MINUTE, Redis-lock → fireDue: MessengerService.sendMessage as author + notify 'messenger.scheduled.sent'; permanent fail cancels, transient retries). Endpoints under /messenger/chats/:id/scheduled + /messenger/scheduled/:id. ~1min fire granularity (cron) — accepted (Telegram-like).

## Reply/quote (messenger-native, NOT registry)
Message.replyToId self-relation; MESSAGE_REPLY_INCLUDE in getMessages/send/edit; ChatMessage.replyTo preview; sendMessage validates the quote is in the same chat. Web: composer quoted-bar + per-bubble quoted block (click → jumpToMessage flash, reuses Phase-5/6 mechanism).

## Verified
verify-quickactions.cjs 20/0 (registry+perms+scope, reply+cross-chat 400, scheduled lifecycle+validation+access+cron-fire+author ping). nest build + web tsc clean. Payloads matched to backend schemas. Committed to main (merge 3a67bfb). NOT browser-smoked (Chrome ext off that session).
