import type { AiSessionSummary } from '../api/ai.ts';

export interface AiSessionMessage {
  id: string;
  role: string;
  content: string;
  payload?: {
    suggestions?: unknown[];
    references?: unknown[];
    reasoning?: string;
    meta?: Record<string, unknown> | null;
  } | null;
  [key: string]: unknown;
}

export interface AiSessionGateway {
  list: (query?: string) => Promise<AiSessionSummary[]>;
  messages: (id: string) => Promise<AiSessionMessage[]>;
  create?: (input?: Record<string, unknown>) => Promise<{ id: string }>;
  rename?: (id: string, title: string) => Promise<unknown>;
  remove?: (id: string) => Promise<unknown>;
}

export interface AiSessionStoreState {
  currentId: string | null;
  rows: AiSessionSummary[];
  messages: AiSessionMessage[];
  loading: boolean;
  error: string | null;
}

export function createAiSessionStore(gateway: AiSessionGateway, initial: Partial<AiSessionStoreState> = {}) {
  let state: AiSessionStoreState = {
    currentId: initial.currentId ?? null,
    rows: initial.rows ?? [],
    messages: initial.messages ?? [],
    loading: false,
    error: null,
  };
  const listeners = new Set<(state: AiSessionStoreState) => void>();
  const setState = (next: Partial<AiSessionStoreState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener(state));
  };
  return {
    getState: () => state,
    subscribe: (listener: (next: AiSessionStoreState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh(query?: string) {
      setState({ loading: true, error: null });
      try {
        const rows = await gateway.list(query);
        setState({ rows, loading: false });
        return rows;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ loading: false, error: message });
        throw error;
      }
    },
    async select(id: string) {
      setState({ loading: true, error: null, currentId: id });
      try {
        const messages = await gateway.messages(id);
        setState({ messages, loading: false });
        return messages;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ loading: false, error: message });
        throw error;
      }
    },
    async create(input: Record<string, unknown> = {}) {
      if (!gateway.create) throw new Error('Session creation is not supported');
      const created = await gateway.create(input);
      setState({ currentId: created.id, messages: [] });
      return created.id;
    },
    async rename(id: string, title: string) {
      if (!gateway.rename) throw new Error('Session rename is not supported');
      await gateway.rename(id, title);
      setState({ rows: state.rows.map((row) => row.id === id ? { ...row, title } : row) });
    },
    async remove(id: string) {
      if (!gateway.remove) throw new Error('Session deletion is not supported');
      await gateway.remove(id);
      setState({ rows: state.rows.filter((row) => row.id !== id), currentId: state.currentId === id ? null : state.currentId, messages: state.currentId === id ? [] : state.messages });
    },
  };
}

