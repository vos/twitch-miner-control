import { Button, Group, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useState } from "react";

export function AddStreamer({ onAdd }: { onAdd: (username: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onAdd(value.trim());
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
        placeholder="twitch username"
        leftSection={<IconSearch size={16} stroke={1.7} />}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <Button loading={busy} onClick={() => void submit()}>Add</Button>
    </Group>
  );
}
