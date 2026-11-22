import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

/** Tabs mirror the three domains; the label is also the document title. */
const TABS = [
  { to: '/games', label: '棋局对弈' },
  { to: '/chats', label: 'AI 聊天室' },
  { to: '/work', label: '开发任务' },
] as const;

/**
 * The header title is the domain, not the page: the page keeps its own compact
 * head for things like the room name or the current game. Keeping one title in
 * the shell is what stops every page from rendering its own topbar.
 *
 * Replay is checked first: both `/replay/:id` and `/games/:id/replay` are
 * replay views, and a plain `/games` prefix test would label the latter as a
 * live game.
 */
function titleFor(pathname: string): string {
  if (pathname.startsWith('/replay') || /^\/games\/[^/]+\/replay$/.test(pathname)) {
    return '棋谱回放';
  }
  if (pathname.startsWith('/games')) {
    return '棋局对弈';
  }
  if (pathname.startsWith('/chats')) {
    return 'AI 聊天室';
  }
  if (pathname.startsWith('/work')) {
    return '开发任务';
  }
  return '大厅';
}

export function AppShell() {
  const { pathname } = useLocation();
  const title = titleFor(pathname);

  useEffect(() => {
    document.title = `${title} · Agent Arena`;
  }, [title]);

  return (
    <div className="app">
      <header className="topbar">
        <Link className="brand brand--link" to="/">
          <p className="eyebrow">Agent Arena · MCP</p>
          <h1 className="title">{title}</h1>
        </Link>
        <nav className="shell-nav" aria-label="主导航">
          {TABS.map((tab) => (
            <NavLink key={tab.to} className="shell-nav-link" to={tab.to}>
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
