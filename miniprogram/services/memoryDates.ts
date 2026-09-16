/** 时间轴书签上竖排的日期：月份数字、「月」、日期数字、「日」各占一行。 */
export function bookmarkDateParts(iso: string): string[] {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return [];
  return [`${date.getMonth() + 1}`, "月", `${date.getDate()}`, "日"];
}
