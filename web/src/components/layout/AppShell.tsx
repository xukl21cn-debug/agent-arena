import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import styles from './AppShell.module.scss';

/** Tabs mirror the three domains; the label is also the document title. */
interface ShellTab {
  to: string;
  label: string;
  /** Shown on hover, for tabs whose availability depends on the deployment. */
  hint?: string;
}

const TABS: ShellTab[] = [
  { to: '/games', label: '棋局对弈' },
  { to: '/chats', label: 'AI 聊天室' },
  {
    to: '/work',
    label: '开发任务',
    hint: '看板只在后端监听回环地址时可用',
  },
];

/**
 * The header title mirrors the route table in `App.tsx` exactly instead of
 * matching prefixes. A path that matches no route is redirected to `/`, so it
 * has to read as the lobby here too — otherwise the header would describe a
 * page that never renders.
 *
 * Two normalizations keep this table honest: a trailing slash is the same
 * route, and the router matches case-insensitively, so `/GAMES/x/REPLAY` is a
 * replay even though the pattern here is written in lowercase.
 */
function titleFor(rawPathname: string): string {
  const pathname = rawPathname.replace(/\/+$/, '').toLowerCase() || '/';
  if (pathname === '/') {
    return '大厅';
  }
  if (pathname === '/games' || /^\/games\/[^/]+$/.test(pathname)) {
    return '棋局对弈';
  }
  if (/^\/games\/[^/]+\/replay$/.test(pathname)) {
    return '棋谱回放';
  }
  if (pathname === '/replay' || /^\/replay\/[^/]+$/.test(pathname)) {
    return '棋谱回放';
  }
  if (pathname === '/chats' || /^\/chats\/[^/]+$/.test(pathname)) {
    return 'AI 聊天室';
  }
  if (pathname === '/work') {
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
    <div className={styles.app}>
      <header className={styles.topbar}>
        <Link className={styles.brandLink} to="/">
          <p className={styles.eyebrow}>Agent Arena · MCP</p>
          <h1 className={styles.title}>{title}</h1>
        </Link>
        <nav className={styles.shellNav} aria-label="主导航">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              className={styles.shellNavLink}
              title={tab.hint}
              to={tab.to}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
