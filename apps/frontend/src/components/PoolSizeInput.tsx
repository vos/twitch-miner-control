import { NumberInput, Tooltip } from "@mantine/core";
import { useEffect, useState } from "react";
import classes from "./PoolSizeInput.module.css";

/**
 * A 1-10 channel count, committed on blur or Enter.
 *
 * Held locally so the digits can be edited freely -- half a number is a
 * legal thing to have typed and an illegal thing to save. Committed on
 * blur or Enter rather than per keystroke: a commit can cost a directory
 * resolve and a restart, so typing "6" over "3" must not first ask for a
 * pool of one.
 */
export function PoolSizeInput({ value, label, hint, disabled, onCommit }: {
  value: number;
  /** Accessible name, e.g. "Channels for Rust Drops". */
  label: string;
  /** Why anyone would change it, shown on hover. */
  hint: string;
  disabled: boolean;
  onCommit: (size: number) => void;
}) {
  const [draft, setDraft] = useState<string | number>(value);
  useEffect(() => { setDraft(value); }, [value]);

  function commit() {
    const size = Number(draft);
    // An emptied box is not a request for zero channels; it falls back to
    // the size in force rather than posting something the server rejects.
    if (!Number.isInteger(size) || size < 1 || size > 10) {
      setDraft(value);
      return;
    }
    if (size === value) return;
    onCommit(size);
  }

  return (
    <Tooltip label={hint} multiline w={260}>
      <NumberInput
        size="xs"
        // Two digits and the stepper, no more. The arrows are hidden
        // until the control is hovered or focused, so a resting row is
        // the number and its unit rather than a column of chevrons.
        w={48}
        min={1}
        max={10}
        clampBehavior="strict"
        aria-label={label}
        disabled={disabled}
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        classNames={{
          root: classes.poolField,
          input: classes.poolInput,
          controls: classes.poolStepper,
        }}
      />
    </Tooltip>
  );
}
