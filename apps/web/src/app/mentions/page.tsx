import { redirect } from 'next/navigation';

// Лента упоминаний слилась с центром уведомлений: «Упоминания» — вкладка/фильтр.
// Старый адрес живёт редиректом — на него вели закладки и старые deep link'и.
export default function MentionsRedirect() {
  redirect('/notifications?filter=mentions');
}
