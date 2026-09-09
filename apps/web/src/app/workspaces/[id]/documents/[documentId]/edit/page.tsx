'use client';

// ============================================================
// Правка блочного документа (свободного или по builder-шаблону): тот же
// конструктор, что у шаблона, но с данными ЭТОГО документа. Правка возможна,
// пока сервер отдаёт can.edit — после отправки на маршрут дорога сюда закрыта.
// ============================================================

import { useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { emptyBuilderDoc, isDocDateRangeValue, type BuilderDoc, type DocFormFieldDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { orgDocumentKey, templateFieldGroupsKey } from '@/lib/queries';
import { BentoGrid, Button, Card, EmptyState, LoadingBlock, PageHeader } from '@/components/ui';
import { BuilderEditorLazy } from '@/components/doc-builder/BuilderEditorLazy';
import { documentsApi, fetchOrgDocument, fetchTemplateFieldGroups } from '../../documents-api';

export default function EditOrgDocumentPage() {
  const tr = useTranslations('documents');
  const { isReady } = useRequireAuth();
  const { id, documentId } = useParams<{ id: string; documentId: string }>();
  const router = useRouter();

  const docQuery = useQuery({
    queryKey: orgDocumentKey(id, documentId),
    queryFn: () => fetchOrgDocument(id, documentId),
    enabled: isReady,
  });

  // Чужой workspaceId в адресе → на родной (см. карточку документа)
  useEffect(() => {
    const doc = docQuery.data;
    if (doc && doc.workspaceId !== id) {
      router.replace(`/workspaces/${doc.workspaceId}/documents/${doc.id}/edit`);
    }
  }, [docQuery.data, id, router]);
  const groupsQuery = useQuery({
    queryKey: templateFieldGroupsKey,
    queryFn: fetchTemplateFieldGroups,
    staleTime: 30 * 60 * 1000,
  });

  const doc = docQuery.data ?? null;

  // Чипы «Форма.…» — объявление полей документа (из шаблона либо своё у свободного);
  // у старых документов без объявления — по ключам значений (период узнаётся по форме)
  const formFields = useMemo<DocFormFieldDto[]>(() => {
    if (doc?.formFields?.length) return doc.formFields;
    return Object.keys(doc?.fields ?? {}).map((key) => ({
      key,
      label: key,
      kind: isDocDateRangeValue((doc?.fields ?? {})[key]) ? 'daterange' : 'text',
    }));
  }, [doc?.formFields, doc?.fields]);

  if (!isReady || docQuery.isPending) return <LoadingBlock />;


  if (!doc || !doc.builderDoc || !doc.can?.edit) {
    return (
      <>
        <PageHeader breadcrumb={tr('page.title')} title={tr('edit.unavailable')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title={tr(doc && !doc.can?.edit ? 'edit.closed' : 'card.failedTitle')}
              description={doc && !doc.builderDoc ? tr('edit.bodyInEditor') : undefined}
              action={
                <Button variant="matte" icon="arrowLeft" href={`/workspaces/${id}/documents/${documentId}`}>
                  {tr('edit.toCard')}
                </Button>
              }
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb={`${tr('page.title')} · ${doc.docTypeName}`}
        title={doc.title}
        actions={
          <Button variant="ghost" icon="arrowLeft" href={`/workspaces/${id}/documents/${documentId}`}>
            {tr('edit.toCardShort')}
          </Button>
        }
      />
      <BentoGrid>
        <Card span={12}>
          <BuilderEditorLazy
            key={doc.id}
            initial={(doc.builderDoc ?? emptyBuilderDoc()) as BuilderDoc}
            fieldGroups={groupsQuery.data ?? []}
            formFields={formFields}
            onSave={async (next) => {
              await documentsApi.updateDocument(id, documentId, { builderDoc: next });
            }}
            onPreview={(next) => documentsApi.previewDocumentPdf(id, documentId, next)}
            // Свои поля — только у СВОБОДНОГО документа: у документа по шаблону
            // форма принадлежит шаблону, и править её надо там (сервер это и требует)
            formHint={
              tr(doc.templateId ? 'edit.formHintTemplate' : 'edit.formHintFree')
            }
            onAddFormField={
              doc.templateId
                ? undefined
                : async (f) => {
                    await documentsApi.updateDocument(id, documentId, {
                      formFields: [...formFields, f],
                    });
                    await docQuery.refetch();
                  }
            }
          />
        </Card>
      </BentoGrid>
    </>
  );
}
