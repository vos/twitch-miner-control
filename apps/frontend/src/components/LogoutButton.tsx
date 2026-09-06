import { Button } from "@mantine/core";
import { IconLogout } from "@tabler/icons-react";
import { useState } from "react";
import { api } from "../api/client.js";
import { useSession } from "./session.js";

/**
 * Ends the browser session, mirroring the gate's Unlock button.
 *
 * Full-width and the same size as the dock's miner actions, but `subtle`
 * and dimmed: locking up is a rare, deliberate act and must not read as
 * loudly as Start/Stop, which sit directly above it.
 */
export function LogoutButton() {
  const { onLoggedOut } = useSession();
  const [busy, setBusy] = useState(false);

  const logOut = async () => {
    setBusy(true);
    try {
      await api.post("/api/session/logout");
    } catch {
      // Locking the UI is the point, and the button is only reachable with
      // a session. A failed call means the cookie may still be live, so the
      // safe move is to lock anyway and make the user prove it again.
    } finally {
      setBusy(false);
      onLoggedOut();
    }
  };

  return (
    <Button
      fullWidth
      size="sm"
      variant="subtle"
      color="gray"
      leftSection={<IconLogout size={16} stroke={1.7} />}
      data-testid="logout"
      loading={busy}
      onClick={() => void logOut()}
    >
      Log out
    </Button>
  );
}
