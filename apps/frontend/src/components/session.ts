import { createContext, useContext } from "react";

/**
 * Lets anything below the gate drop the session and send the app back to
 * the password screen.
 *
 * A context rather than a prop threaded App -> Sidebar -> MinerDock: the
 * lock state lives in PasswordGate, and every layer in between would
 * otherwise carry a prop it has no use for.
 *
 * The default reloads instead of throwing, so a component rendered outside
 * the gate -- which is how the dock's own tests mount it -- still behaves
 * sanely. The cookie is already gone by then, so the reload lands on the
 * password screen anyway.
 */
export const SessionContext = createContext<{ onLoggedOut: () => void }>({
  onLoggedOut: () => window.location.reload(),
});

export const useSession = () => useContext(SessionContext);
