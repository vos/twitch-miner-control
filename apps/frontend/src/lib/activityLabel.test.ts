import { expect, test } from "vitest";
import { activityLabel } from "./activityLabel.js";

test("strips the gain prefix down to the reason", () => {
  expect(activityLabel("GAIN_FOR_CLAIM")).toBe("claim");
  expect(activityLabel("GAIN_FOR_WATCH_STREAK")).toBe("watch streak");
});

test("reads any other event type as words", () => {
  expect(activityLabel("STREAMER_ONLINE")).toBe("streamer online");
  expect(activityLabel("PREDICTION_WIN")).toBe("prediction win");
});
