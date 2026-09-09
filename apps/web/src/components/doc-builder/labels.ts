// ============================================================
// Слова для НЕ-React слоёв конструктора.
//
// Схема BlockNote и разбор блоков — модульный уровень: хука каталога у них нет
// (тот же случай, что у схемы ProseMirror в «Заметках»). Поэтому единственный
// React-владелец — `BuilderEditor` — кладёт нужные слова сюда при отрисовке, а
// слои читают их в момент, когда слово действительно понадобилось.
//
// Значения по умолчанию — на языке ИСТОЧНИКА: они видны только до первой
// отрисовки редактора, то есть практически никогда.
// ============================================================

export interface BuilderLabels {
  /** Роль подписанта по умолчанию у нового блока подписи */
  signatureRole: string;
}

let current: BuilderLabels = { signatureRole: 'Director' };

export function setBuilderLabels(labels: BuilderLabels): void {
  current = labels;
}

export function builderLabels(): BuilderLabels {
  return current;
}
