'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { FileDto } from '@superapp/shared';
import { getDownloadUrl } from '../../lib/files-api';
import { createDocumentFromFile, documentHref, getDocsStatus, isEditableDocument } from '../../lib/docs-api';
import type { DocsPlace } from '../../lib/docs-api';
import { docsStatusKey } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { fileIcon, humanSize } from './files-ui';

/** Кнопки открытия документа: правка выделена цветом — это действие с последствиями */
function docButtonStyle(busy: boolean, accent: boolean): React.CSSProperties {
  return {
    border: 'none',
    background: accent ? 'var(--primary-container, var(--surface-container-high))' : 'var(--surface-container-high)',
    borderRadius: 'var(--radius-sketch)',
    cursor: busy ? 'default' : 'pointer',
    fontSize: '0.7rem',
    fontWeight: 600,
    lineHeight: 1,
    padding: '0.25rem 0.45rem',
    color: 'var(--on-surface)',
    flexShrink: 0,
    opacity: busy ? 0.5 : 1,
    whiteSpace: 'nowrap',
  };
}

interface FileChipProps {
  file: Pick<FileDto, 'id' | 'name' | 'size' | 'kind' | 'mime' | 'status'>;
  onRemove?: () => void;
  onClick?: () => void;
  /**
   * Место, в котором лежит вложение (задача, сообщение чата). Задано → офисный файл
   * можно открыть: кликом по самому вложению или кнопкой. От места наследуется право
   * ПРАВКИ, а само открытие — тот явный акт, которым файл становится документом.
   */
  docPlace?: DocsPlace;
}

/**
 * Компактная строка-файл (вложение в чате/задаче/форме): иконка типа, имя,
 * размер, скачивание. Аналог PersonChip, но для файлов.
 */
export function FileChip({ file, onRemove, onClick, docPlace }: FileChipProps) {
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const router = useRouter();

  // Движок документов может быть выключен (нет редактора) — тогда кнопки нет вовсе.
  const { data: docsStatus } = useQuery({
    queryKey: docsStatusKey,
    queryFn: getDocsStatus,
    enabled: !!docPlace && file.status === 'ready' && isEditableDocument(file),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  const canOpenInEditor = !!docPlace && !!docsStatus?.enabled && isEditableDocument(file);

  /**
   * Открыть документ. Режим — ЯВНЫЙ выбор человека: «Просмотр» открывает только на
   * чтение, «Редактировать» — на правку (сервер всё равно срежет до его прав).
   * Правка общего файла видна всем участникам места, поэтому она не должна
   * случаться от одного клика «посмотреть, что там».
   */
  const openDoc = async (e: React.MouseEvent, readonly: boolean) => {
    e.stopPropagation();
    if (opening || !docPlace) return;
    setOpening(true);
    // Вкладку открываем ПРЯМО СЕЙЧАС, пустой: id документа станет известен только
    // после запроса к серверу, а window.open уже вне жеста пользователя блокировщик
    // попапов гасит. Дальше просто переводим её на нужный адрес.
    // Адрес свой же (тот же origin), поэтому noopener не нужен — зато сохраняется
    // возможность закрыть вкладку кнопкой внутри документа.
    const tab = window.open('', '_blank');
    try {
      const doc = await createDocumentFromFile({
        fileId: file.id,
        refType: docPlace.refType,
        refId: docPlace.refId,
      });
      const href = documentHref(doc.id, docPlace, { readonly });
      // replace, а не assign: пустая about:blank не должна оставаться в истории
      // вкладки — иначе «назад» в ней ведёт в пустоту.
      if (tab) tab.location.replace(href);
      else router.push(href); // попап всё-таки заблокирован — открываем на месте
    } catch (err) {
      tab?.close();
      alert(apiErrorMessage(err));
    } finally {
      setOpening(false);
    }
  };

  const download = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || file.status !== 'ready') return;
    setBusy(true);
    try {
      const { url } = await getDownloadUrl(file.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      a.click();
    } finally {
      setBusy(false);
    }
  };

  // Клик по самому вложению = ПРОСМОТР (безопасный режим): по файлу кликают, чтобы
  // «глянуть, что там», и это не повод пускать человека править общий документ.
  const chipClick = onClick ?? (canOpenInEditor ? (e: React.MouseEvent) => openDoc(e, true) : undefined);

  return (
    <div
      onClick={chipClick}
      title={!onClick && canOpenInEditor ? 'Открыть документ' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        maxWidth: '100%',
        padding: '0.35rem 0.6rem',
        background: 'var(--surface-container)',
        borderRadius: 'var(--radius-sketch)',
        cursor: chipClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: '1rem', lineHeight: 1 }}>{fileIcon(file.kind)}</span>
      <span
        style={{
          fontSize: '0.8rem',
          fontWeight: 600,
          color: 'var(--on-surface)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '14rem',
        }}
        title={file.name}
      >
        {file.name}
      </span>
      <span style={{ fontSize: '0.7rem', color: 'var(--on-surface-variant)', flexShrink: 0 }}>
        {humanSize(file.size)}
      </span>
      {canOpenInEditor && (
        <>
          <button
            type="button"
            onClick={(e) => openDoc(e, true)}
            disabled={opening}
            title="Открыть только для чтения — ничего не изменится"
            style={docButtonStyle(opening, false)}
          >
            👁 Просмотр
          </button>
          <button
            type="button"
            onClick={(e) => openDoc(e, false)}
            disabled={opening}
            title="Открыть на правку: изменения сохраняются автоматически и видны всем, кому доступен файл"
            style={docButtonStyle(opening, true)}
          >
            ✏️ Редактировать
          </button>
        </>
      )}
      {file.status === 'ready' && (
        <button
          type="button"
          onClick={download}
          disabled={busy}
          title="Скачать"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '0.85rem',
            lineHeight: 1,
            padding: '0.1rem',
            opacity: busy ? 0.4 : 0.8,
          }}
        >
          ⬇️
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Убрать"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '0.8rem',
            lineHeight: 1,
            padding: '0.1rem',
            color: 'var(--on-surface-variant)',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
