import { LegalDocumentPage } from '../../../LegalDocumentPage';

export default async function LegalDocVersionPage({ params }: { params: Promise<{ doc: string; version: string }> }) {
  const { doc, version } = await params;
  return <LegalDocumentPage doc={doc} version={version} />;
}
