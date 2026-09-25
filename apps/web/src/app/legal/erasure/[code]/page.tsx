import { ErasureReceiptPage } from '../ErasureReceiptPage';

export default async function ErasureReceiptRoute({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <ErasureReceiptPage code={code} />;
}
