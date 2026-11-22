import { useMemo } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigationType,
  useParams,
} from 'react-router';
import { DEFAULT_ROOM_ID, ROOM_ID_PATTERN } from '@arena/shared';
import { ChatRoomPage } from './components/chat/ChatRoomPage';
import { GamePage } from './components/game/GamePage';
import { AppShell } from './components/layout/AppShell';
import { LobbyPage, noteLobbyEntry } from './components/lobby/LobbyPage';
import { ReplayPage } from './components/replay/ReplayPage';
import { WorkPage } from './components/work/WorkPage';

/** Archive ids become path segments, so they must be safe before we build one. */
const ARCHIVE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

function normalizeRoomId(raw: string | null | undefined): string {
  return raw !== null && raw !== undefined && ROOM_ID_PATTERN.test(raw)
    ? raw
    : DEFAULT_ROOM_ID;
}

/**
 * The pre-router URLs carried their target in the query string. Map them onto
 * the new paths once, keeping the old precedence: archive, then replay, then
 * chat, then work, then a bare room.
 *
 * Invalid room ids collapse to the default room rather than falling through to
 * the lobby: the constraint is that only a URL without `room` reaches the
 * lobby, and a garbage value still has to land on a room.
 */
function legacyTarget(search: string): string | null {
  const params = new URLSearchParams(search);

  const archive = params.get('archive');
  if (archive !== null) {
    return archive !== '' && ARCHIVE_ID_PATTERN.test(archive)
      ? `/replay/${archive}`
      : '/replay';
  }
  if (params.get('view') === 'replay') {
    return `/games/${normalizeRoomId(params.get('room'))}/replay`;
  }
  if (params.get('kind') === 'chat') {
    return `/chats/${normalizeRoomId(params.get('room'))}`;
  }
  if (params.get('view') === 'work') {
    return '/work';
  }
  if (params.has('room')) {
    return `/games/${normalizeRoomId(params.get('room'))}`;
  }
  return null;
}

/** `/` is the lobby, unless an old query string says otherwise. */
/**
 * The lobby keeps its tab, filter and page in module memory keyed by history
 * entry. React reuses this component across `/games` and `/chats` because the
 * type is the same, and a reused instance never re-reads that memory — so each
 * entry gets its own instance.
 */
function LobbyRoute({ domain }: { domain?: 'games' | 'chats' }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  noteLobbyEntry(location.key, location.pathname, navigationType);
  return <LobbyPage key={location.key} domain={domain} />;
}

function RootRoute() {
  const target = useMemo(() => legacyTarget(window.location.search), []);
  const location = useLocation();
  const navigationType = useNavigationType();
  if (target !== null) {
    return <Navigate replace to={target} />;
  }
  noteLobbyEntry(location.key, location.pathname, navigationType);
  return <LobbyPage key={location.key} />;
}

function RoomReplayRoute() {
  const params = useParams();
  const roomId = normalizeRoomId(params.roomId);
  return <ReplayPage key={`room-${roomId}`} roomId={roomId} />;
}

function ArchiveReplayRoute() {
  const params = useParams();
  const archiveId = params.archiveId ?? '';
  return <ReplayPage key={archiveId} archiveId={archiveId} />;
}

function ChatRoomRoute() {
  const params = useParams();
  return <ChatRoomPage roomId={normalizeRoomId(params.roomId)} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route element={<RootRoute />} path="/" />
          <Route element={<LobbyRoute domain="games" />} path="/games" />
          <Route element={<GamePage />} path="/games/:roomId" />
          <Route element={<RoomReplayRoute />} path="/games/:roomId/replay" />
          <Route element={<ArchiveReplayRoute />} path="/replay" />
          <Route element={<ArchiveReplayRoute />} path="/replay/:archiveId" />
          <Route element={<LobbyRoute domain="chats" />} path="/chats" />
          <Route element={<ChatRoomRoute />} path="/chats/:roomId" />
          <Route element={<WorkPage />} path="/work" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
