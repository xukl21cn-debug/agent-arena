import { Link, useLocation, useNavigate } from 'react-router';

/**
 * "Back to the list" for a detail page.
 *
 * When the tab was opened from inside the app, going back in history is the
 * honest move: the lobby keeps its filters and page number per history entry,
 * so `navigate(-1)` restores exactly what the user was looking at. A deep link
 * or a refresh has no in-app entry behind it (React Router marks the first
 * entry with key `default`), so it falls back to the section's list path.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const hasParent = location.key !== 'default';

  return (
    <Link
      className="back-link"
      to={to}
      onClick={(event) => {
        // Let the browser handle new-tab and modified clicks.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (hasParent) {
          navigate(-1);
        } else {
          navigate(to);
        }
      }}
    >
      ← {label}
    </Link>
  );
}
