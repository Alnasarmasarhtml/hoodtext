import type { ReactNode } from 'react';

import { RoomCreate } from '@/components/app/RoomCreate';

/**
 * `/app/rooms/new` — the create-room pane.
 *
 * A static route (no dynamic segment), so it survives the static export the
 * same way `/app/thread` does. The rail stays mounted beside it on wide
 * screens; on narrow ones this pane takes the screen like a thread would.
 */
export default function NewRoomPage(): ReactNode {
  return <RoomCreate />;
}
