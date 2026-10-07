export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function periodDates(year, month) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Choose a year from 1900 to 2100 and a valid month.");
  }
  return {
    closeDate: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
    reversalDate: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
  };
}

export function periodLabel(year, month) {
  periodDates(year, month);
  return `${MONTHS[month - 1]} ${year}`;
}
