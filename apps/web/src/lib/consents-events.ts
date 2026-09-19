// Событие окна «сервер отказал шлюзом согласий» (`403 consents.pending`): перехватчик транспорта
// (`lib/api.ts`) его бросает, `ConsentGate` — слушает и перечитывает `GET /consents/pending`.
// Отдельный файл без зависимостей: `lib/api.ts` не должен тянуть за собой React-компоненты.
export const CONSENTS_PENDING_EVENT = 'sa6:consents-pending';
export const CONSENTS_PENDING_CODE = 'consents.pending';
