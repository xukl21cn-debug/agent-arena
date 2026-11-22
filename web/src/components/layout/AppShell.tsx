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
 * The header title is the domain, not the page: the page keeps its own compact
 * head for things like the room name or the current game. Keeping one title in
 * the shell is what stops every page from rendering its own topbar.
 *
 * Replay is checked first: both `/replay/:id` and `/games/:id/replay` are
 * replay views, and a plain `/games` prefix test would label the latter as a
 * live game.
 */
function titleFor(rawPathname: string): string {
  // A trailing slash is the same route; `/games/default/replay/` must not fall
  // through to the live-game branch.
  const pathname = rawPathname.replace(/\/+$/, '') || '/';
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
