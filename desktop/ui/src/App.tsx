import { useApp, type Page } from './store';
import { Icon } from './components/ui';
import { clock, elapsed } from './util';
import { Today } from './pages/Today';
import { Week } from './pages/Week';
import { Goals } from './pages/Goals';
import { Review } from './pages/Review';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';

const NAV: { id: Page; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '周计划' },
  { id: 'goals', label: '目标' },
  { id: 'review', label: '复盘' },
  { id: 'chat', label: '聊天' },
];

/** Small always-visible timer, so a running round is never out of sight. */
function TimerPill() {
  const { S, now, go, page } = useApp();
  const a = S.active;
  if (!a || page === 'today') return null;
  const e = elapsed(a, now);
  const shown = a.mode === 'down' ? a.budget - e : e;
  const label = a.phase === 'due' ? '时间到' : a.phase === 'paused' ? '已暂停' : clock(shown);
  return (
    <button type="button" className={`timer-pill ${a.phase}`} onClick={() => go('today')} title={`${a.title}（点击回到今天）`}>
      <span className="dot" />
      <span className="pill-clock">{label}</span>
      <span className="pill-title">{a.title}</span>
    </button>
  );
}

export function App() {
  const { page, go } = useApp();
  return (
    <div className="shell">
      <nav className="rail" aria-label="主导航">
        <div className="brand" title="T计划">T</div>
        {NAV.map((n) => (
          <button key={n.id} type="button" className={`rail-item${page === n.id ? ' on' : ''}`} onClick={() => go(n.id)}
            aria-current={page === n.id ? 'page' : undefined} data-nav={n.id}>
            <Icon name={n.id} size={20} />
            <span>{n.label}</span>
          </button>
        ))}
        <div className="rail-space" />
        <button type="button" className={`rail-item${page === 'settings' ? ' on' : ''}`} onClick={() => go('settings')} data-nav="settings">
          <Icon name="settings" size={20} />
          <span>设置</span>
        </button>
      </nav>
      <main className={`content page-${page}`}>
        <TimerPill />
        {page === 'today' && <Today />}
        {page === 'week' && <Week />}
        {page === 'goals' && <Goals />}
        {page === 'review' && <Review />}
        {page === 'chat' && <Chat />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}
