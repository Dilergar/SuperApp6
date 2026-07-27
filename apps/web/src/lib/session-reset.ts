// ============================================================
// Сброс ВСЕХ клиентских кэшей при смене пользователя.
//
// Зачем: выход делает router.push('/login') — это клиентский переход, вкладка не
// перезагружается. Значит переживают выход: кэш React Query (создаётся один раз на
// вкладку) и модульные кэши скинов и сущностей-пикеров (у них вообще нет TTL).
// Вошедший следом в той же вкладке успевал увидеть данные предыдущего аккаунта:
// staleTime у запросов 60 секунд, то есть в этом окне React Query отдаёт кэш и даже
// не идёт в сеть. Классика общего устройства.
//
// Регистрация вместо модульного синглтона QueryClient: сам клиент по-прежнему
// создаётся в Providers через useState (правильный паттерн для SSR — модульный
// синглтон на сервере жил бы один на все запросы). Сюда кладётся ссылка на него
// уже в браузере.
// ============================================================
import type { QueryClient } from '@tanstack/react-query';
import { resetPersonSkins } from './person-skins';
import { invalidateEntities } from './entities';

let queryClient: QueryClient | null = null;

/** Вызывается один раз из Providers на клиенте. */
export function registerQueryClient(client: QueryClient) {
  queryClient = client;
}

/** Забыть всё, что относилось к прошлому пользователю. */
export function resetSessionCaches() {
  queryClient?.clear();
  resetPersonSkins();
  invalidateEntities();
}
