// Глобальная loading-граница App Router.
//
// Без неё каждый клик по навигации МОЛЧИТ до полного ответа сервера: корневой
// layout читает cookie сайдбара → всё дерево динамическое, а префетч
// динамического роута без loading.tsx не даёт ничего рисуемого. С границей
// переход мгновенно показывает спиннер в рабочей области (каркас остаётся).
export default function Loading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
      <span className="ui-spinner" style={{ width: 28, height: 28 }} aria-label="Загрузка" role="status" />
    </div>
  );
}
