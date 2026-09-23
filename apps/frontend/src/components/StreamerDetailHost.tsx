import { lazy, Suspense, useState } from "react";
import { useLiveState } from "../api/useLiveState.js";

// Split out: the dialog brings recharts, which nearly doubles the bundle,
// and no screen should wait on it to paint.
const StreamerDetailModal = lazy(() =>
  import("./StreamerDetailModal.js")
    .then((m) => ({ default: m.StreamerDetailModal })));

/**
 * The streamer detail dialog, for whichever screen asked for it.
 *
 * Owned by the shell so the command palette can open a streamer over any
 * screen. One dialog for the whole app, not one per card: a fifty-streamer
 * roster would otherwise mount fifty modals to show at most one.
 */
export function StreamerDetailHost({ login, onClose }: {
  login: string | null;
  onClose: () => void;
}) {
  const { snapshot } = useLiveState();
  // Mounted from the first open onward, never before: mounting it up front
  // would fetch the chunk the lazy import exists to defer.
  const [used, setUsed] = useState(false);
  if (login !== null && !used) setUsed(true);
  if (!used) return null;

  return (
    <Suspense fallback={null}>
      <StreamerDetailModal
        streamer={snapshot?.streamers.find((s) => s.username === login) ?? null}
        opened={login !== null}
        onClose={onClose}
      />
    </Suspense>
  );
}
