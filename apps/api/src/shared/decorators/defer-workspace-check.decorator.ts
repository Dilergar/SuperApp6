import { SetMetadata } from '@nestjs/common';

export const DEFER_WORKSPACE_CHECK_KEY = 'deferWorkspaceCheck';

/**
 * Маршрут, которому запрещён поход в БД на пути запроса (приём аналитики): интерцептор
 * контекста НЕ проверяет членство по `X-Workspace-Id`, а кладёт заголовок в
 * `claimedWorkspaceId`. `activeWorkspaceId` при этом не ставится — chokepoint не
 * включается, и ни один запрос к данным организации на таком маршруте невозможен.
 * Проверку членства обязан сделать потребитель заявленного id (консьюмер аналитики).
 */
export const DeferWorkspaceCheck = () => SetMetadata(DEFER_WORKSPACE_CHECK_KEY, true);
