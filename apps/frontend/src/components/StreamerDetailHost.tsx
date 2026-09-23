import { Center, Group, Loader, Modal, Text } from "@mantine/core";
import { lazy, Suspense, useEffect, useState } from "react";
import { useLiveState, type StreamerState } from "../api/useLiveState.js";
import { useBalanceMotion } from "../lib/balanceMotion.js";
import { StreamerAvatar } from "./StreamerAvatar.js";

// Split out: the dialog brings recharts, which nearly doubles the bundle,
// and no screen should wait on it to paint.
type ModalComponent = typeof import("./StreamerDetailModal.js").StreamerDetailModal;

/**
 * The dialog component once its chunk has arrived, by whichever route.
 *
 * Rendered directly when set at the first open, bypassing lazy:
 * React.lazy only starts on its first render, and even an import that
 * already finished resolves a tick later, so going through lazy would
 * flash the loading dialog for a frame even after a preload.
 */
let loaded: ModalComponent | null = null;
const loadModal = () => import("./StreamerDetailModal.js").then((m) => {
  loaded = m.StreamerDetailModal;
  return m;
});
const LazyModal = lazy(() => loadModal().then((m) => ({ default: m.StreamerDetailModal })));

/**
 * Stands in for the dialog while its code loads: the same modal, opened
 * at once over the same title, so a click is answered immediately rather
 * than looking ignored for as long as the chunk takes to arrive.
 */
function DetailLoading({ login, streamer, onClose }: {
  login: string | null;
  streamer: StreamerState | null;
  onClose: () => void;
}) {
  if (login === null) return null;
  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={
        <Group gap="sm" wrap="nowrap">
          <StreamerAvatar
            login={login}
            displayName={streamer?.displayName ?? null}
            avatarUrl={streamer?.avatarUrl ?? null}
            size={32}
          />
          <Text fw={600}>{streamer?.displayName ?? login}</Text>
        </Group>
      }
    >
      <Center
        h={240} role="status" aria-busy="true" aria-label="Loading details"
        data-testid="detail-code-loading"
      >
        <Loader size="sm" />
      </Center>
    </Modal>
  );
}

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
  const animateBalance = useBalanceMotion();
  // Chosen at the first open and kept: mounted from then on, never
  // before (mounting it up front would fetch the chunk the lazy import
  // exists to defer), and never swapped. The loaded component if the chunk
  // is already here, else the lazy one -- which stays even after the chunk
  // lands, since changing component type would remount the open dialog.
  const [Dialog, setDialog] = useState<ModalComponent | typeof LazyModal | null>(null);
  if (login !== null && Dialog === null) setDialog(() => loaded ?? LazyModal);

  // Fetched once the browser has nothing better to do, so the first card
  // opened usually finds the dialog already here. Idle rather than on
  // mount: the dashboard paints first and never waits on it. Safari has no
  // requestIdleCallback, so it gets a plain delay instead.
  useEffect(() => {
    const preload = () => { void loadModal(); };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(preload, 2000);
    return () => clearTimeout(timer);
  }, []);

  if (Dialog === null) return null;
  const streamer = snapshot?.streamers.find((s) => s.username === login) ?? null;

  return (
    <Suspense fallback={<DetailLoading login={login} streamer={streamer} onClose={onClose} />}>
      <Dialog
        streamer={streamer}
        opened={login !== null}
        onClose={onClose}
        animateBalance={animateBalance}
      />
    </Suspense>
  );
}
