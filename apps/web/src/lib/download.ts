/** Отдать пользователю готовые байты файлом (выгрузки, протоколы, «Мои данные»). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Освобождаем адрес не сразу: Safari успевает начать скачивание не мгновенно.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
