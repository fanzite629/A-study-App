// Types for the data the main process sends, and the typed bridge to it.
// The bridge itself is defined in src/preload/app.js.

export interface Task {
  id: string; title: string; cat: string; date: string | null; at: string | null; est: number;
  done: boolean; doneAt: number | null; pin: boolean; createdAt: number;
  next: string | null; goalId: string | null; week: string | null; origin: 'user' | 'agent';
}
export interface Session {
  id: string; title: string; taskId: string | null; date: string; start: number; end: number;
  minutes: number; durationMs: number; note: string; outcome: 'done' | 'continue' | null; step: string | null;
}
export interface Active {
  id: string; title: string; taskId: string | null; mode: 'up' | 'down'; budget: number;
  startedAt: number; lastAt: number; acc: number; phase: 'running' | 'paused' | 'due'; step: string | null;
  autoPaused: string | null;
}
export interface Goal {
  id: string; parentId: string | null; title: string; note: string;
  status: 'active' | 'done' | 'dropped'; origin: 'user' | 'agent'; createdAt: number; order: number;
}
export interface WeekPlan { weekStart: string; focus: string; goalIds: string[]; capacityMin: number | null; note: string; origin: 'user' | 'agent'; }
export interface Review {
  id: string; scope: 'day' | 'week'; key: string; reflection: string;
  aiDraft: { text: string; model: string | null; at: number } | null; updatedAt: number;
}
export interface State {
  tasks: Task[]; sessions: Session[]; goals: Goal[]; weeks: Record<string, WeekPlan>; reviews: Review[];
  main: Record<string, string>; active: Active | null;
  settings: { eveningReview?: boolean; reviewTime?: string };
  desktop: { rev: number; rest: { startedAt: number; endsAt: number } | null };
}
export interface AppState { state: State; now: number; pet: { visible: boolean; quiet: boolean }; dataDir: string; version: string; }

export interface FactRow {
  taskId: string | null; title: string; minutes: number; count: number; done: boolean | null;
  next: string | null; goalId: string | null; taskDeleted: boolean; notes: string[];
}
export interface DayFacts {
  scope: 'day'; key: string; minutes: number; count: number; tasks: FactRow[];
  noRecord: { taskId: string; title: string; done: boolean; est: number }[];
  planned: number; plannedDone: number; review: Review | null;
}
export interface WeekFacts {
  scope: 'week'; key: string; days: string[]; minutes: number; count: number;
  perDay: { date: string; minutes: number; count: number }[]; tasks: FactRow[];
  goals: { goalId: string | null; title: string; minutes: number }[];
  planned: number; plannedDone: number; plannedMinutes: number;
  noRecord: { taskId: string; title: string; date: string | null }[];
  plan: WeekPlan | null; review: Review | null;
}
export interface GoalNode {
  id: string; title: string; note: string; status: Goal['status']; origin: Goal['origin'];
  tasks: { id: string; title: string; done: boolean; date: string | null; est: number; next: string | null; minutes: number; origin: string }[];
  children: GoalNode[]; minutes: number; taskCount: number; taskDone: number;
}

export interface Profile {
  id: string; name: string; baseUrl: string; model: string; hasKey: boolean; keyHint: string;
  tools: boolean | null; toolsNote: string; testedAt: number | null;
}
export interface ProfileList { activeId: string | null; profiles: Profile[]; encryption: boolean; }
export interface ProbeResult { ok: boolean; tools: boolean; reply?: string; error?: string; toolsNote?: string; }

export interface ToolCall { id: string; name: string; arguments: string; }
export interface ChatMessage {
  id: string; at: number; role: 'user' | 'assistant' | 'tool'; content: string;
  reasoning?: string; toolCalls?: ToolCall[]; model?: string; error?: string; stopped?: boolean;
  toolCallId?: string; name?: string; label?: string; proposalId?: string; failed?: boolean;
}
export interface DraftNode { title: string; note?: string; tasks?: { title: string; est?: number }[]; children?: DraftNode[]; }
export type ProposalPreview =
  | { kind: 'tasks'; tasks: { title: string; date: string | null; est?: number; goal: string | null }[] }
  | { kind: 'goalTree'; parent: string | null; tree: DraftNode }
  | { kind: 'week'; weekStart: string; days: string[]; focus: string; capacityMin: number | null; goals: string[];
      items: { title: string; date: string | null; est: number | null; isNew: boolean }[]; totalMinutes: number }
  | { kind: 'taskUpdate'; task: string; changes: { field: string; from: unknown; to: unknown }[] };
export interface Proposal {
  id: string; tool: string; title: string; preview: ProposalPreview;
  status: 'pending' | 'accepted' | 'rejected' | 'failed'; error: string | null; at: number;
}
export interface ChatMeta { id: string; title: string; createdAt: number; updatedAt: number; }
export interface Conversation extends ChatMeta { messages: ChatMessage[]; proposals: Record<string, Proposal>; running: boolean; }
export type ChatEvent = { chatId: string } & (
  | { type: 'start' }
  | { type: 'delta'; content?: string; reasoning?: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'title'; title: string }
  | { type: 'done'; stopped?: boolean; error?: string }
);

export interface Result { ok: boolean; error?: string; [k: string]: unknown }
type Off = () => void;

export interface Bridge {
  get(): Promise<AppState>;
  dispatch(type: string, payload?: Record<string, unknown>): Promise<Result>;
  query<T>(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; data: T; error?: string }>;
  action(name: string, arg?: unknown): void;
  importData(): Promise<Result>;
  exportData(): Promise<Result>;
  onUpdate(cb: (s: AppState) => void): Off;
  onGoto(cb: (page: string) => void): Off;
  ai: {
    profiles(): Promise<ProfileList>;
    saveProfile(input: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string; tools?: boolean }): Promise<Result & { profile?: Profile }>;
    removeProfile(id: string): Promise<Result>;
    setActive(id: string): Promise<Result>;
    testProfile(id: string): Promise<ProbeResult>;
  };
  chat: {
    list(): Promise<ChatMeta[]>;
    create(): Promise<ChatMeta>;
    load(id: string): Promise<Conversation | null>;
    remove(id: string): Promise<boolean>;
    send(p: { chatId: string; text: string; profileId?: string }): Promise<Result & { needProfile?: boolean }>;
    stop(id: string): Promise<Result>;
    decide(p: { chatId: string; proposalId: string; accept: boolean }): Promise<Result & { proposal?: Proposal }>;
    onEvent(cb: (e: ChatEvent) => void): Off;
  };
  review: { draft(p: { scope: 'day' | 'week'; key: string; profileId?: string }): Promise<Result & { needProfile?: boolean }> };
}

declare global { interface Window { tplan: Bridge } }
export const api: Bridge = window.tplan;
