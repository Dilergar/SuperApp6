// Граница ожидания сервиса — правило платформы: у каждого раздела свой loading.tsx
// (в корне app/ его держать нельзя, там он вешает 404 на вечный спиннер).
export { default } from '@/components/shell/RouteLoading';
