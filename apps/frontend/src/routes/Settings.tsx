import { Alert, Radio, Stack, Switch, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { PendingBar } from "../components/PendingBar.js";

interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>;
  streamers: Array<{ username: string; enabled: boolean; settings: Record<string, unknown> }>;
}

export function Settings() {
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Config>("/api/config").then((c) => { setSaved(c); setDraft(c); });
  }, []);

  if (!draft || !saved) return null;

  const changed =
    draft.followers !== saved.followers ||
    draft.followersOrder !== saved.followersOrder;

  const apply = async () => {
    setBusy(true);
    try {
      await api.put("/api/config", draft);
      await api.post("/api/config/apply");
      setSaved(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack pb={80}>
      <Title order={2}>Settings</Title>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      <Switch
        label="Mine my followed channels"
        description="Adds every channel you follow on Twitch to the mining list."
        checked={draft.followers}
        onChange={(e) => setDraft({ ...draft, followers: e.currentTarget.checked })}
      />
      <Radio.Group
        label="Follower order"
        value={draft.followersOrder}
        onChange={(value) => setDraft({ ...draft, followersOrder: value })}
      >
        <Stack gap="xs" mt="xs">
          <Radio value="ASC" label="Oldest first" />
          <Radio value="DESC" label="Newest first" />
        </Stack>
      </Radio.Group>
      <PendingBar count={changed ? 1 : 0} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}
