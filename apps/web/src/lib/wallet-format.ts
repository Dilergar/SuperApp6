/**
 * Сумма кошелька с учётом МАСШТАБА валюты (`Currency.scale` — суммы хранятся целыми
 * минимальными единицами: 0 у коинов, 2 у фиата).
 *
 * До 2026-08-07 это было три разных форматтера в трёх файлах, и два из них про scale
 * не знали вовсе: у личных валют он равен нулю, поэтому мина не была видна — первая
 * же валюта со scale=2 показала бы суммы ×100.
 */
export function formatWalletAmount(amount: number, scale: number): string {
  const value = scale > 0 ? amount / 10 ** scale : amount;
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
}
