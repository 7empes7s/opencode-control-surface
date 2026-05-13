export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const parseField = (field: string, min: number, max: number): number[] | null => {
    if (field === "*") {
      const result: number[] = [];
      for (let i = min; i <= max; i++) result.push(i);
      return result;
    }

    if (field.includes("/")) {
      const [range, stepStr] = field.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) return null;

      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          const [s, e] = range.split("-").map(Number);
          if (isNaN(s) || isNaN(e)) return null;
          start = s;
          end = e;
        } else {
          start = parseInt(range, 10);
          if (isNaN(start)) return null;
        }
      }

      const result: number[] = [];
      for (let i = start; i <= end; i += step) result.push(i);
      return result;
    }

    if (field.includes(",")) {
      const result: number[] = [];
      for (const part of field.split(",")) {
        const parsed = parseField(part.trim(), min, max);
        if (!parsed) return null;
        result.push(...parsed);
      }
      return result.sort((a, b) => a - b);
    }

    if (field.includes("-")) {
      const [start, end] = field.split("-").map(Number);
      if (isNaN(start) || isNaN(end)) return null;
      const result: number[] = [];
      for (let i = start; i <= end; i++) result.push(i);
      return result;
    }

    const num = parseInt(field, 10);
    if (isNaN(num) || num < min || num > max) return null;
    return [num];
  };

  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dayOfMonth = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dayOfWeek = parseField(parts[4], 0, 6);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function matchesCron(date: Date, fields: CronFields): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (!fields.minute.includes(minute)) return false;
  if (!fields.hour.includes(hour)) return false;
  if (!fields.dayOfMonth.includes(dayOfMonth)) return false;
  if (!fields.month.includes(month)) return false;
  if (!fields.dayOfWeek.includes(dayOfWeek)) return false;

  return true;
}

export function getNextRunTime(expr: string, timezone = "UTC", from = Date.now()): number | null {
  const fields = parseCronExpression(expr);
  if (!fields) return null;

  const MAX_ITERATIONS = 1000;
  const date = new Date(from);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    date.setSeconds(0, 0);
    date.setMinutes(date.getMinutes() + 1);

    if (matchesCron(date, fields)) {
      return date.getTime();
    }
  }

  return null;
}

export function isDue(nextRunAt: number, now = Date.now(), toleranceMs = 30_000): boolean {
  return nextRunAt <= now + toleranceMs;
}

export function getBackoffMs(attemptCount: number, baseMs = 60_000, maxMs = 3_600_000): number {
  return Math.min(baseMs * Math.pow(2, attemptCount), maxMs);
}