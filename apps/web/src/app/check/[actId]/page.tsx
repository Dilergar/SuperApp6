import { CheckView } from '../CheckView';

/**
 * Проверка по ссылке из QR на протоколе подписания: `/check/<actId>?k=<токен>`.
 * Файл здесь не нужен — токен и есть указание на конкретную подпись.
 */
export default async function CheckByTokenPage({
  params,
  searchParams,
}: {
  params: Promise<{ actId: string }>;
  searchParams: Promise<{ k?: string }>;
}) {
  const { actId } = await params;
  const { k } = await searchParams;
  return <CheckView actId={actId} token={k} />;
}
