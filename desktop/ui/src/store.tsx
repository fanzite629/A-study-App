import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type AppState, type Result, type State } from './api';
import { ymd } from './util';

export type Page = 'today' | 'week' | 'goals' | 'review' | 'chat' | 'settings';
export const PAGES: Page[] = ['today', 'week', 'goals', 'review', 'chat', 'settings'];

interface Ctx {
  app: AppState;
  S: State;
  /** Wall clock, ticking every second while a timer or break is running. */
  now: number;
  today: string;
  page: Page;
  go(page: Page, opts?: { chatDraft?: string }): void;
  /** Text to place in the chat box on arrival (consumed once). */
  takeChatDraft(): string | null;
  /** Send a command to the Core; failures surface as a toast. */
  run(type: string, payload?: Record<string, unknown>): Promise<Result>;
  toast(text: string): void;
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const initialPage = (): Page => {
  const h = location.hash.slice(1) as Page;
  return PAGES.includes(h) ? h : 'today';
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [app, setApp] = useState<AppState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [page, setPage] = useState<Page>(initialPage);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const draft = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get().then((s) => { if (live) setApp(s); });
    const off = api.onUpdate((s) => setApp(s));
    return () => { live = false; off(); };
  }, []);

  const ticking = !!app && (!!app.state.active || !!app.state.desktop.rest);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30000);
    return () => clearInterval(t);
  }, [ticking]);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l, { id, text }]);
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);

  const run = useCallback(async (type: string, payload?: Record<string, unknown>) => {
    const r = await api.dispatch(type, payload);
    if (!r.ok && r.error) toast(r.error);
    return r;
  }, [toast]);

  const go = useCallback((p: Page, opts?: { chatDraft?: string }) => {
    if (opts?.chatDraft !== undefined) draft.current = opts.chatDraft;
    setPage(p);
    history.replaceState(null, '', '#' + p);
  }, []);

  useEffect(() => api.onGoto((p) => { if (PAGES.includes(p as Page)) go(p as Page); }), [go]);

  const takeChatDraft = useCallback(() => { const d = draft.current; draft.current = null; return d; }, []);
  const today = ymd(new Date(now));

  const value = useMemo<Ctx | null>(() => (app ? { app, S: app.state, now, today, page, go, takeChatDraft, run, toast } : null),
    [app, now, today, page, go, takeChatDraft, run, toast]);

  if (!value) return <div className="boot">正在打开 T计划…</div>;
  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status">{toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </AppCtx.Provider>
  );
}
