import { LegalDocumentPage } from '../LegalDocumentPage';

export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  return <LegalDocumentPage doc={doc} />;
}
