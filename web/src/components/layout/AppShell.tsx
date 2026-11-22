import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import styles from './AppShell.module.scss';
import { PageTitleContext } from './PageTitle';

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
 * Each route declares its own title through `usePageTitle`, so the header can
 * never disagree with what actually rendered.
 */
export function AppShell() {
  const [title, setTitle] = useState('大厅');

  useEffect(() => {
    document.title = `${title} · Agent Arena`;
  }, [title]);

  return (
    <PageTitleContext.Provider value={setTitle}>
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
    </PageTitleContext.Provider>
  );
}
