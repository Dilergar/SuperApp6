'use client';

import { useState } from 'react';
import type { FileDto } from '@superapp/shared';
import { useFileUpload } from '../../lib/hooks/useFileUpload';
import { useFileDisplayUrl } from '../../lib/hooks/useFileUrl';
import { FileDropzone } from './FileDropzone';
import { UploadProgressList } from './UploadProgressList';
import { FileChip } from './FileChip';
import { ImageLightbox } from './ImageLightbox';
import { fileIcon } from './files-ui';

interface AttachmentsSectionProps {
  files: FileDto[];
  canEdit: boolean;
  /** Профиль загрузки (по умолчанию chat_attachment — приватный, любой тип) */
  profile?: string;
  onAttach: (file: FileDto) => void;
  onRemove: (fileId: string) => void;
}

/**
 * Переиспользуемая секция вложений (задачи и любые сущности): грид миниатюр
 * изображений + чипы документов, дропзона загрузки (при canEdit). Кирпич движка
 * файлов — сущность-специфику (endpoints/права) держит вызывающий.
 */
export function AttachmentsSection({
  files,
  canEdit,
  profile = 'chat_attachment',
  onAttach,
  onRemove,
}: AttachmentsSectionProps) {
  const [lightbox, setLightbox] = useState<FileDto | null>(null);
  const uploader = useFileUpload(profile, { onUploaded: onAttach });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {files.map((f) =>
            f.kind === 'image' ? (
              <ImageTile key={f.id} file={f} canEdit={canEdit} onOpen={() => setLightbox(f)} onRemove={() => onRemove(f.id)} />
            ) : (
              <FileChip key={f.id} file={f} onRemove={canEdit ? () => onRemove(f.id) : undefined} />
            ),
          )}
        </div>
      )}

      {canEdit && (
        <>
          <FileDropzone onFiles={(fs) => uploader.add(fs)} paste multiple compact label="Прикрепить файл" />
          <UploadProgressList
            items={uploader.items.filter((i) => i.status !== 'done')}
            onCancel={uploader.cancel}
            onRemove={uploader.remove}
          />
        </>
      )}

      {!canEdit && files.length === 0 && (
        <p className="label-sm" style={{ opacity: 0.6, fontSize: '0.75rem' }}>Вложений нет.</p>
      )}

      {lightbox && <ImageLightbox file={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function ImageTile({
  file,
  canEdit,
  onOpen,
  onRemove,
}: {
  file: FileDto;
  canEdit: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { url } = useFileDisplayUrl(file, 'thumb');
  return (
    <div style={{ position: 'relative', width: 72, height: 72, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-container-high)' }}>
      <div onClick={onOpen} style={{ width: '100%', height: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: '1.4rem' }}>{fileIcon(file.kind)}</span>
        )}
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          title="Убрать"
          style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, border: 'none', borderRadius: '50%', background: 'rgba(56,57,45,0.65)', color: '#fff', fontSize: '0.6rem', cursor: 'pointer', lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
