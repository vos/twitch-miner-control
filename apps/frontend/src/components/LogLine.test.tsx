import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { LogLine } from "./LogLine.js";

/** The class name carries the level; assert on it rather than on color. */
const classOf = (text: string) =>
  render(<LogLine text={text} />).container.firstElementChild!.className;

test("paints an error line differently from an info line", () => {
  const err = classOf("05/09/26 12:00:00 - ERROR - mod - [fn]: websocket closed");
  const info = classOf("05/09/26 12:00:00 - INFO - mod - [fn]: started");
  expect(err).not.toEqual(info);
});

test("gives a points gain its own treatment", () => {
  const gain = classOf("05/09/26 12:00:00 - INFO - mod - [fn]: +50 -> forsen");
  const info = classOf("05/09/26 12:00:00 - INFO - mod - [fn]: started");
  expect(gain).not.toEqual(info);
});

test("renders the line's text verbatim", () => {
  const line = "05/09/26 12:00:00 - INFO - mod - [fn]: hello";
  const { container } = render(<LogLine text={line} />);
  expect(container.textContent).toBe(line);
});
