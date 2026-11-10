import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

const paths: Record<string, string> = {
  today: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  week: 'M4 6h16v14H4zM4 10h16M9 4v4m6-4v4',
  goals: 'M12 3v6m0 0H6v4m6-4h6v4M6 13v2m12-2v2M4 15h4v5H4zm6 0h4v5h-4zm6 0h4v5h-4z',
  review: 'M5 19V9m5 10V5m5 14v-7m5 7V8',
  chat: 'M4 5h16v11H9l-5 4z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-.7a6 6 0 0 0-.6-1.4l1-1.9-1.4-1.4-1.9 1a6 6 0 0 0-1.4-.6L13 4h-2l-.7 2a6 6 0 0 0-1.4.6l-1.9-1L5.6 7l1 1.9a6 6 0 0 0-.6 1.4L4 11v2l2 .7c.1.5.3 1 .6 1.4l-1 1.9L7 18.4l1.9-1c.4.3.9.5 1.4.6L11 20h2l.7-2c.5-.1 1-.3 1.4-.6l1.9 1 1.4-1.4-1-1.9c.3-.4.5-.9.6-1.4L20 13z',
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
  stop: 'M6 6h12v12H6z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12',
  check: 'm5 12 5 5 9-10',
  star: 'm12 4 2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2 8 13.7 4 9.8 9.5 9z',
  send: 'M5 12h13m-5-6 6 6-6 6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  chevron: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  x: 'M6 6l12 12M18 6 6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
};

export function Icon({ name, size = 18, fill }: { name: keyof typeof paths | string; size?: number; fill?: boolean }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function IconButton({ name, label, onClick, active, danger, disabled, fill }:
  { name: string; label: string; onClick: () => void; active?: boolean; danger?: boolean; disabled?: boolean; fill?: boolean }) {
  return (
    <button type="button" className={`iconbtn${active ? ' on' : ''}${danger ? ' danger' : ''}`} title={label} aria-label={label}
      onClick={onClick} disabled={disabled}>
      <Icon name={name} size={16} fill={fill} />
    </button>
  );
}

/** One-line input that commits on Enter and clears itself. */
export function QuickAdd({ placeholder, onAdd, autoFocus, onCancel }:
  { placeholder: string; onAdd: (text: string) => void | Promise<unknown>; autoFocus?: boolean; onCancel?: () => void }) {
  const [v, setV] = useState('');
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && v.trim()) { void onAdd(v.trim()); setV(''); }
    if (e.key === 'Escape') { setV(''); onCancel?.(); }
  };
  return <input className="quickadd" value={v} maxLength={150} placeholder={placeholder} autoFocus={autoFocus}
    onChange={(e) => setV(e.target.value)} onKeyDown={key} onBlur={() => { if (!v.trim()) onCancel?.(); }} />;
}

/** Text that turns into an input on double-click (or via the edit button). */
export function Editable({ value, onSave, className, editing, onDone }:
  { value: string; onSave: (v: string) => void; className?: string; editing?: boolean; onDone?: () => void }) {
  const [on, setOn] = useState(false);
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const active = on || !!editing;
  useEffect(() => { if (active) { setV(value); requestAnimationFrame(() => ref.current?.select()); } }, [active, value]);
  const close = (save: boolean) => {
    if (save && v.trim() && v.trim() !== value) onSave(v.trim());
    setOn(false); onDone?.();
  };
  if (!active) return <span className={className} onDoubleClick={() => setOn(true)} title="双击修改">{value}</span>;
  return <input ref={ref} className="editable" value={v} maxLength={150} onChange={(e) => setV(e.target.value)}
    onBlur={() => close(true)}
    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) close(true); if (e.key === 'Escape') close(false); }} />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><p className="empty-title">{title}</p>{children}</div>;
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ai' | 'muted' | 'ok' | 'warn' }) {
  return <span className={`badge ${tone || ''}`}>{children}</span>;
}

export function Confirm({ text, yes, onYes, onNo }: { text: string; yes: string; onYes: () => void; onNo: () => void }) {
  return (
    <span className="confirm">
      <span>{text}</span>
      <button type="button" className="btn sm danger" onClick={onYes}>{yes}</button>
      <button type="button" className="btn sm ghost" onClick={onNo}>取消</button>
    </span>
  );
}
