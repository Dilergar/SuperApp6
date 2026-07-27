# Web Auth Pattern (apps/web)

## Источник правды: useAuthStore (Zustand)
Файл: `apps/web/src/lib/stores/auth.ts`

- State: `user | null`, `isAuthenticated`, `isHydrated`
- Actions: `hydrate()`, `login(phone, password)`, `register({phone, password, firstName, lastName?})`, `logout()`, `fetchProfile()`
- Токены хранятся в `localStorage` (`accessToken`, `refreshToken`) — store сам их пишет/читает, компоненты НЕ трогают localStorage напрямую

## Гидратация
`Providers` (`apps/web/src/app/providers.tsx`) вызывает `hydrate()` в useEffect при монтировании. Если токен есть → fetch `/users/me` → user заполняется.

**Токены сносятся ТОЛЬКО на 401/403** (правка 2026-07-27). Раньше стоял голый `catch`, и
любой 5xx, таймаут или оффлайн на старте уничтожал refresh-токен — блип API выкидывал
человека вводить пароль заново. 401 сюда долетает уже ПОСЛЕ неудачной попытки обновления
интерсептором, то есть сессия действительно мертва; всё остальное — не повод.

Это значит: на любой странице после первого рендера `isHydrated === true` и можно доверять `isAuthenticated`.

## Защищённые страницы: useRequireAuth
Файл: `apps/web/src/lib/hooks/useRequireAuth.ts`

Использование:
```tsx
const { isReady, user } = useRequireAuth();
if (!isReady) return <Loading />;
// далее user гарантированно не null
```

Хук сам редиректит на `/login` если после гидрации пользователь не залогинен. Все будущие страницы `/tasks`, `/calendar`, `/circles` должны использовать этот хук, а не копипастить логику.

## axios interceptor (lib/api.ts)
Отдельный слой — читает `accessToken` из localStorage напрямую (не через store, чтобы избежать циклической зависимости). Auto-refresh на 401: дёргает `/auth/refresh`, сохраняет новые токены, ретраит запрос. При провале — чистит токены и редиректит на `/login`.

## Смена аккаунта чистит ВСЕ клиентские кэши (2026-07-27)
`lib/session-reset.ts` → `resetSessionCaches()` зовётся в `logout()`, `login()` и
`applySession()`. Чистит кэш React Query + модульные кэши `person-skins` и `entities`.

Зачем: выход делает `router.push('/login')` — это КЛИЕНТСКИЙ переход, вкладка не
перезагружается. QueryClient живёт один на вкладку, модульные кэши вообще без TTL —
следующий вошедший в те же 60 секунд staleTime получал кэш предыдущего человека и
React Query даже не шла в сеть. Классика общего устройства.

Клиент регистрируется через `registerQueryClient(queryClient)` прямо в теле `Providers`
(синхронно, до эффектов — выход может случиться раньше любого эффекта). Модульным
синглтоном QueryClient делать НЕЛЬЗЯ: на сервере он был бы один на все запросы.
`resetPersonSkins()` (в отличие от `invalidatePersonSkins()`) НЕ перезапрашивает —
запрос ушёл бы уже без токена.

## Middleware НЕ используется
Next.js middleware серверный и не видит localStorage. Защита сугубо клиентская через useRequireAuth. Если в будущем перейдём на httpOnly cookies — можно добавить серверный middleware.
