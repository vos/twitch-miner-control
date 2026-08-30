import { Button, Group, TextInput } from "@mantine/core";
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
    <Group>
      <TextInput
        label="Add streamer"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <Button mt="lg" loading={busy} onClick={() => void submit()}>Add</Button>
    </Group>
  );
}
