import { Alert, Center, Loader, Stack } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import {
  notifyApi, type Destination, type DestinationPatch, type NotifyConfig,
} from "../api/notify.js";
import { useLiveState } from "../api/useLiveState.js";
import { DestinationList } from "../components/notify/DestinationList.js";
import { PrefsEditor } from "../components/notify/PrefsEditor.js";
import { ThisBrowserCard } from "../components/notify/ThisBrowserCard.js";
import { currentEndpoint, disable, enable, support, type PushSupport } from "../lib/push.js";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function Notifications() {
  const { snapshot } = useLiveState();
  const [config, setConfig] = useState<NotifyConfig | null>(null);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  // This browser's push endpoint, which is how it finds its own row.
  const [here, setHere] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pushSupport, setPushSupport] = useState<PushSupport>(() => support());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [c, d, endpoint] = await Promise.all([
      notifyApi.config(), notifyApi.destinations(), currentEndpoint(),
    ]);
    setConfig(c);
    setDestinations(d.destinations);
    setHere(endpoint);
  }, []);

  useEffect(() => {
    reload().catch((cause) => setError(messageOf(cause)));
  }, [reload]);

  const mine = here === null ? null : destinations.find((d) => d.endpoint === here) ?? null;
  const others = destinations.filter((d) => d.id !== mine?.id);
  const selected = destinations.find((d) => d.id === selectedId) ?? mine ?? others[0] ?? null;
  const roster = (snapshot?.streamers ?? []).map((s) => ({
    value: s.username, label: s.displayName ?? s.username,
  }));

  const save = async (id: string, patch: DestinationPatch) => {
    // Shown at once; the server's answer replaces it.
    setDestinations((all) => all.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    try {
      const { destination } = await notifyApi.update(id, patch);
      setDestinations((all) => all.map((d) => (d.id === id ? destination : d)));
    } catch (cause) {
      setError(messageOf(cause));
      void reload().catch(() => undefined);
    }
  };

  const turnOn = async () => {
    if (config === null) return;
    setBusy(true);
    setError(null);
    try {
      const destination = await enable(config.vapidPublicKey);
      setHere(destination.endpoint);
      setDestinations((all) => [...all.filter((d) => d.id !== destination.id), destination]);
      setSelectedId(destination.id);
    } catch (cause) {
      setError(messageOf(cause));
      setPushSupport(support());
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await disable(mine?.id ?? null);
      setDestinations((all) => all.filter((d) => d.id !== mine?.id));
      setHere(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await notifyApi.remove(id);
      setDestinations((all) => all.filter((d) => d.id !== id));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const test = async (id: string): Promise<string | null> => {
    try {
      const result = await notifyApi.test(id);
      return result.ok ? null : result.error ?? "The test could not be delivered.";
    } catch (cause) {
      return messageOf(cause);
    }
  };

  if (config === null) {
    return error === null
      ? <Center py="xl" role="status" aria-label="Loading notifications"><Loader size="sm" /></Center>
      : <Alert color="red">{error}</Alert>;
  }

  return (
    <Stack maw={760} gap="lg">
      {error !== null && (
        <Alert color="red" withCloseButton closeButtonLabel="Dismiss" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <ThisBrowserCard
        support={pushSupport}
        destination={mine}
        busy={busy}
        onTurnOn={() => void turnOn()}
        onTurnOff={() => void turnOff()}
        onSave={(patch) => { if (mine !== null) void save(mine.id, patch); }}
        onTest={() => (mine === null ? Promise.resolve(null) : test(mine.id))}
      />
      {selected !== null && (
        <PrefsEditor
          key={selected.id}
          config={config}
          heading={selected.id === mine?.id ? "Events for this browser" : `Events for ${selected.label}`}
          prefs={selected.prefs}
          roster={roster}
          onChange={(prefs) => void save(selected.id, { prefs })}
        />
      )}
      <DestinationList
        destinations={others}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onTest={test}
        onToggle={(d) => void save(d.id, { enabled: !d.enabled })}
        onRemove={(id) => void remove(id)}
      />
    </Stack>
  );
}
