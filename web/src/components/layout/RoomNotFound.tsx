import { Link } from 'react-router';
import { BackLink } from './BackLink';

/**
 * The shared empty state for a room id that no longer resolves: a 1008 close
 * with ROOM_NOT_FOUND is not a transient network failure, so the page says the
 * room is gone instead of "连接中…" or a playable board. Each page keeps its own
 * title and lobby wording through props; the shape and style are shared.
 */
export function RoomNotFound({
  title,
  to,
  backLabel,
  actionLabel,
  body,
}: {
  /** Page title above the empty state, e.g. 棋局对弈. */
  title: string;
  /** Lobby path both links lead to, e.g. /games. */
  to: string;
  /** Top back-link label, e.g. 棋局大厅. */
  backLabel: string;
  /** Action button label, e.g. 返回棋局大厅. */
  actionLabel: string;
  /** The hint paragraph under the heading. */
  body: string;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to={to} label={backLabel} />
          <h2 className="page-title">{title}</h2>
          <p className="page-subtitle">房间不存在或已删除。</p>
        </div>
      </div>
      <section className="room-not-found panel" role="status">
        <strong>房间不存在或已删除</strong>
        <p>{body}</p>
        <Link className="btn btn--primary" to={to}>
          {actionLabel}
        </Link>
      </section>
    </>
  );
}
