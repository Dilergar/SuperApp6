'use client';

import { useState } from 'react';
import type { FileDto } from '@superapp/shared';
import type { DocsPlace } from '../../lib/docs-api';
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
  /**
   * Профиль для КАРТИНОК, если он отличается от `profile`.
   *
   * Профиль движка файлов несёт белый список MIME: `document` не принимает фото,
   * `asset_photo` — только фото. Секция «Фото и документы» обязана принимать и то
   * и другое, поэтому здесь ДВА загрузчика, и файл едет в свой по типу. Не задан —
   * поведение прежнее: всё уходит одним профилем.
   */
  imageProfile?: string;
  /**
   * Место вложения (напр. {refType:'task', refId}) — включает у офисных файлов
   * кнопку «Редактировать»: право правки документа наследуется именно от места.
   */
  docPlace?: DocsPlace;
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
  imageProfile,
  docPlace,
  onAttach,
  onRemove,
}: AttachmentsSectionProps) {
  const [lightbox, setLightbox] = useState<FileDto | null>(null);
  const uploader = useFileUpload(profile, { onUploaded: onAttach });
  // Второй загрузчик существует всегда (хуки не вызываются условно), но получает
  // файлы, только если вызывающий объявил отдельный профиль для картинок.
  const imageUploader = useFileUpload(imageProfile ?? profile, { onUploaded: onAttach });

  const addFiles = (incoming: FileList | File[]) => {
    const all = Array.from(incoming);
    if (!imageProfile) {
      uploader.add(all);
      return;
    }
    const images = all.filter((f) => f.type.startsWith('image/'));
    const rest = all.filter((f) => !f.type.startsWith('image/'));
    if (images.length > 0) imageUploader.add(images);
    if (rest.length > 0) uploader.add(rest);
  };

  // localId уникален на загрузчик; отмена по чужому id — тихий no-op.
  const pending = [...uploader.items, ...(imageProfile ? imageUploader.items : [])].filter(
    (i) => i.status !== 'done',
  );
  const cancelUpload = (localId: string) => {
    uploader.cancel(localId);
    imageUploader.cancel(localId);
  };
  const removeUpload = (localId: string) => {
    uploader.remove(localId);
    imageUploader.remove(localId);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {files.map((f) =>
            f.kind === 'image' ? (
              <ImageTile key={f.id} file={f} canEdit={canEdit} onOpen={() => setLightbox(f)} onRemove={() => onRemove(f.id)} />
            ) : (
              <FileChip
                key={f.id}
                file={f}
                docPlace={docPlace}
                onRemove={canEdit ? () => onRemove(f.id) : undefined}
              />
            ),
          )}
        </div>
      )}

      {canEdit && (
        <>
          <FileDropzone onFiles={(fs) => addFiles(fs)} paste multiple compact label="Прикрепить файл" />
          <UploadProgressList items={pending} onCancel={cancelUpload} onRemove={removeUpload} />
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
      {/* Настоящая кнопка, не div: просмотр вложения доступен с клавиатуры */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Открыть: ${file.name}`}
        style={{ width: '100%', height: '100%', border: 'none', padding: 0, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: '1.4rem' }}>{fileIcon(file.kind)}</span>
        )}
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          title="Убрать"
          aria-label={`Убрать вложение: ${file.name}`}
          style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, border: 'none', borderRadius: '50%', background: 'rgba(0, 0, 0, 0.65)', color: 'var(--on-primary)', fontSize: '0.6rem', cursor: 'pointer', lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
