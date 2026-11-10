import type { Active } from './api';

export const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
/** Monday of the week containing the date (same rule as the Core). */
export const weekStartOf = (s: string) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
export const weekDays = (ws: string) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(ws, i));
export const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const weekdayOf = (s: string) => WD[parseYmd(s).getDay()];
export const md = (s: string) => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日`; };

export function dayLabel(date: string, today: string) {
  if (date === today) return '今天';
  if (date === addDays(today, 1)) return '明天';
  if (date === addDays(today, -1)) return '昨天';
  return `${md(date)} ${weekdayOf(date)}`;
}

/** Minutes for people: "45 分钟", "1 小时 20 分". Sub-minute rounds stay visible. */
export function fmtMin(min: number) {
  if (min > 0 && min < 1) return '不到 1 分钟';
  const m = Math.round(min);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

export function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
}

export const hm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Elapsed ms of a round: identical to the Core's formula. */
export function elapsed(a: Active | null, now: number) {
  if (!a) return 0;
  let e = a.acc + (a.phase === 'running' ? now - a.lastAt : 0);
  if (a.mode === 'down') e = Math.min(e, a.budget);
  return Math.max(0, e);
}

export const sum = <T,>(list: T[], f: (x: T) => number) => list.reduce((n, x) => n + f(x), 0);
export const round2 = (n: number) => Math.round(n * 100) / 100;
