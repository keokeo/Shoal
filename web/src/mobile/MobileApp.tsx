import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, MobileRouteVia, ServerMsg, SessionActivity, Snapshot } from '../../../shared/protocol.ts';
import { connect, send } from '../ws.ts';
import { mobileGet, mobilePost, setMobileUnauthorizedHandler } from './api.ts';
import type { TermStreamEvent } from './EmergencyTerminalDrawer.tsx';
import { MobileHome } from './MobileHome.tsx';
import { NewTaskSheet } from './MobileSheets.tsx';
import { MobileTaskView } from './MobileTaskView.tsx';
import { PairScreen } from './PairScreen.tsx';

function parseHashRoute(): { pairToken: string | null; taskId: string | null } {
  if (typeof location === 'undefined') return { pairToken: null, taskId: null };
  const h = location.hash.replace(/^#/, '');
  if (!h) return { pairToken: null, taskId: null };
  const params = new URLSearchParams(h);
  return {
    pairToken: params.get('pair'),
    taskId: params.get('task'),
  };
}

function applyServerMsg(prev: Snapshot, m: ServerMsg): Snapshot {
  switch (m.t) {
    case 'snapshot':
      return m.state;
    case 'project': {
      const idx = prev.projects.findIndex((p) => p.id === m.project.id);
      const projects = idx >= 0
        ? prev.projects.map((p, i) => (i === idx ? m.project : p))
        : [...prev.projects, m.project];
      return { ...prev, projects };
    }
    case 'project-removed': {
      const git = { ...prev.git };
      delete git[m.id];
      return { ...prev, projects: prev.projects.filter((p) => p.id !== m.id), git };
    }
    case 'task': {
      const idx = prev.tasks.findIndex((t) => t.id === m.task.id);
      const tasks = idx >= 0
        ? prev.tasks.map((t, i) => (i === idx ? m.task : t))
        : [...prev.tasks, m.task];
      return { ...prev, tasks };
    }
    case 'task-removed':
      return {
        ...prev,
        tasks: prev.tasks.filter((t) => t.id !== m.id),
        cards: prev.cards.filter((c) => c.taskId !== m.id),
      };
    case 'card': {
      const cards = prev.cards.some((c) => c.id === m.card.id)
        ? prev.cards.map((c) => (c.id === m.card.id ? m.card : c))
        : [...prev.cards, m.card];
      return { ...prev, cards };
    }
    case 'session': {
      const idx = prev.sessions.findIndex((s) => s.id === m.session.id);
      const sessions = idx >= 0
        ? prev.sessions.map((s, i) => (i === idx ? m.session : s))
        : [...prev.sessions, m.session];
      return { ...prev, sessions };
    }
    case 'settings':
      return { ...prev, settings: m.settings };
    case 'git':
      return { ...prev, git: { ...prev.git, [m.projectId]: m.git } };
    case 'quota':
      return { ...prev, quota: { ...prev.quota, [m.agent]: m.quota } };
    case 'telemetry':
      return { ...prev, telemetry: m.telemetry };
    case 'activity': {
      const activity: Record<string, SessionActivity> = { ...(prev.activity ?? {}) };
      if (m.activity) activity[m.sessionId] = m.activity;
      else delete activity[m.sessionId];
      return { ...prev, activity };
    }
    default:
      return prev;
  }
}

export function MobileApp() {
  const initialRoute = useRef(parseHashRoute());
  const [pairToken, setPairToken] = useState<string | null>(() => initialRoute.current.pairToken);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => initialRoute.current.taskId);
  const [auth, setAuth] = useState<'checking' | 'paired' | 'unpaired'>('checking');
  const [via, setVia] = useState<MobileRouteVia>('lan');
  const [pairNotice, setPairNotice] = useState('');
  const [state, setState] = useState<Snapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const termSubsRef = useRef(new Set<(ev: TermStreamEvent) => void>());

  // Strip #pair= from URL bar immediately so referrer/history do not keep ephemeral tokens.
  useEffect(() => {
    if (initialRoute.current.pairToken) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    const onHash = () => {
      const r = parseHashRoute();
      if (r.pairToken) {
        setPairToken(r.pairToken);
        history.replaceState(null, '', location.pathname + location.search);
      }
      if (r.taskId) {
        setSelectedTaskId(r.taskId);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const dropToPair = useCallback((reason: string) => {
    setAuth('unpaired');
    setState(null);
    setWsConnected(false);
    setRttMs(null);
    if (reason) setPairNotice(reason);
  }, []);

  useEffect(() => {
    setMobileUnauthorizedHandler(() => dropToPair('设备授权已失效，请重新配对。'));
    return () => setMobileUnauthorizedHandler(null);
  }, [dropToPair]);

  const checkSession = useCallback(async () => {
    try {
      const res = await mobileGet<{ authenticated: boolean; via: MobileRouteVia }>('/api/mobile/session');
      setVia(res.via);
      if (res.authenticated) {
        setPairNotice('');
        setAuth('paired');
      } else {
        setAuth('unpaired');
      }
    } catch {
      setAuth('unpaired');
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (auth !== 'paired') return;
    let alive = true;
    mobileGet<Snapshot>('/api/state').then(
      (snap) => { if (alive) setState(snap); },
      () => {},
    );

    const stopWs = connect({
      onOpen: () => {
        if (!alive) return;
        setWsConnected(true);
        send({ t: 'ping', ts: Date.now() });
      },
      onClose: () => {
        if (alive) setWsConnected(false);
      },
      onMsg: (m) => {
        if (!alive) return;
        if (m.t === 'revoked') {
          dropToPair('当前设备已被桌面端撤销授权。');
          return;
        }
        if (m.t === 'pong') {
          setVia(m.via);
          setRttMs(Math.max(1, Date.now() - m.ts));
          return;
        }
        if (m.t === 'replay' || m.t === 'out') {
          const ev: TermStreamEvent = { kind: m.t, id: m.id, d: m.d };
          for (const fn of termSubsRef.current) fn(ev);
          return;
        }
        setState((prev) => {
          if (m.t === 'snapshot') return m.state;
          return prev ? applyServerMsg(prev, m) : prev;
        });
      },
    });

    const pingTimer = setInterval(() => {
      send({ t: 'ping', ts: Date.now() });
    }, 15_000);

    return () => {
      alive = false;
      clearInterval(pingTimer);
      stopWs();
    };
  }, [auth, dropToPair]);

  const subscribeTerm = useCallback((fn: (ev: TermStreamEvent) => void) => {
    termSubsRef.current.add(fn);
    return () => { termSubsRef.current.delete(fn); };
  }, []);

  const sendMsg = useCallback((m: ClientMsg) => {
    send(m);
  }, []);

  const selectTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
    const nextHash = taskId ? `#task=${encodeURIComponent(taskId)}` : '';
    if (location.hash !== nextHash) {
      history.replaceState(null, '', location.pathname + location.search + nextHash);
    }
  }, []);

  const handleLogout = async () => {
    try {
      await mobilePost('/api/mobile/logout', {});
    } catch { /* ignore */ }
    dropToPair('已解除本机配对。');
  };

  if (auth === 'checking') {
    return (
      <div className="mob-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="mob-sub">正在检查设备授权…</div>
      </div>
    );
  }

  if (auth === 'unpaired') {
    return (
      <PairScreen
        initialPairToken={pairToken}
        notice={pairNotice}
        onClearInitialToken={() => setPairToken(null)}
        onPaired={() => {
          setPairNotice('');
          setAuth('paired');
        }}
      />
    );
  }

  if (!state) {
    return (
      <div className="mob-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="mob-sub">正在同步桌面工作台状态…</div>
      </div>
    );
  }

  const activeTask = selectedTaskId ? state.tasks.find((t) => t.id === selectedTaskId) : undefined;

  if (activeTask) {
    return (
      <MobileTaskView
        task={activeTask}
        state={state}
        now={now}
        wsConnected={wsConnected}
        subscribeTerm={subscribeTerm}
        sendMsg={sendMsg}
        onBack={() => selectTask(null)}
        onOpenTask={(id) => selectTask(id)}
      />
    );
  }

  return (
    <>
      <MobileHome
        state={state}
        via={via}
        rttMs={rttMs}
        wsConnected={wsConnected}
        now={now}
        onSelectTask={(id) => selectTask(id)}
        onOpenNewTask={() => setShowNewTask(true)}
        onLogout={() => void handleLogout()}
      />
      {showNewTask && (
        <NewTaskSheet
          projects={state.projects}
          agents={state.agents}
          defaultAgyModel={state.settings.agyModel}
          onCreated={(id) => {
            setShowNewTask(false);
            selectTask(id);
          }}
          onClose={() => setShowNewTask(false)}
        />
      )}
    </>
  );
}
