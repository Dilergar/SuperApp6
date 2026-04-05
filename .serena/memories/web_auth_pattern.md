# Web Auth Pattern (apps/web)

## Источник правды: useAuthStore (Zustand)
Файл: `apps/web/src/lib/stores/auth.ts`

- State: `user | null`, `isAuthenticated`, `isHydrated`
- Actions: `hydrate()`, `login(phone, password)`, `register({phone, password, firstName, lastName?})`, `logout()`, `fetchProfile()`
- Токены хранятся в `localStorage` (`accessToken`, `refreshToken`) — store сам их пишет/читает, компоненты НЕ трогают localStorage напрямую

## Гидратация
`Providers` (`apps/web/src/app/providers.tsx`) вызывает `hydrate()` в useEffect при монтировании. Если токен есть → fetch `/users/me` → user заполняется. Если 401 → токены чистятся, `isHydrated: true`.

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

## Middleware НЕ используется
Next.js middleware серверный и не видит localStorage. Защита сугубо клиентская через useRequireAuth. Если в будущем перейдём на httpOnly cookies — можно добавить серверный middleware.
