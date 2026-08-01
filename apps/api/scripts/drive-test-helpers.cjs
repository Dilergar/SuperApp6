/* eslint-disable */
// Помощник для сьютов ДВИЖКА файлов и документов.
//
// С появлением Диска свои загрузки из чатов и задач складываются туда сами (модель
// Teams), и файл перестаёт быть сиротой: у него всегда остаётся дом. Это и есть
// задуманное поведение — удаление сообщения не должно уничтожать файл, который лежит
// у человека на Диске.
//
// Но сьюты, которые проверяют УБОРКУ ДВИЖКА («не осталось мест → файл прибран»),
// строятся на посылке «мест больше нет». Здесь мы честно доводим эту посылку до
// правды: дожидаемся, пока укладка на Диск отработает, и убираем дом. Проверяемый
// инвариант движка при этом остаётся ровно тем же.
//
// Имя файла НЕ начинается с verify- намеренно: иначе CI прогонял бы его как сьют.

/** Дождаться, пока джоб drive.ingest уложит файл (или убедиться, что не уложит) */
async function waitForDriveNode(prisma, fileId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = await prisma.driveNode.findFirst({ where: { fileId } });
    if (node) return node;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * Убрать «дом» файла на Диске, не трогая сам файл: узел и его связь. Штатная ручка
 * удаления здесь не годится — она гасит и байты, и проверка движка стала бы
 * бессмысленной (файл оказался бы удалён не тем, что проверяем).
 */
async function dropFromDrive(prisma, fileId) {
  const node = await waitForDriveNode(prisma, fileId);
  if (!node) return false;
  await prisma.fileLink.deleteMany({ where: { fileId, refType: 'drive_node' } });
  await prisma.driveNode.deleteMany({ where: { id: node.id } });
  return true;
}

module.exports = { waitForDriveNode, dropFromDrive };
