import { Button, Group, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { parseStreamerInput } from "../lib/parseStreamerInput.js";

export function AddStreamer({ onAdd }: { onAdd: (username: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);

  const submit = async () => {
    if (!value.trim()) return;
    // A channel link is what you get from copying a streamer in the browser,
    // so it is parsed here and everything downstream -- the duplicate check,
    // the lookup, config.json -- keeps seeing a bare login.
    const username = parseStreamerInput(value);
    if (!username) {
      setInvalid("Enter a Twitch username or channel link");
      return;
    }
    setInvalid(null);
    setBusy(true);
    try {
      await onAdd(username);
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group gap="xs" align="flex-end">
      <TextInput
        flex={1}
        label="Add streamer"
        placeholder="username or https://twitch.tv/username"
        leftSection={<IconSearch size={16} stroke={1.7} />}
        error={invalid}
        value={value}
        onChange={(e) => { setValue(e.currentTarget.value); setInvalid(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <Button loading={busy} onClick={() => void submit()}>Add</Button>
    </Group>
  );
}
