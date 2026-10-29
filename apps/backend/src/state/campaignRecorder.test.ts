import { expect, test, vi } from "vitest";
import { CampaignRecorder } from "./campaignRecorder.js";
import type { Campaign, Catalogue } from "./campaignCatalogue.js";
import type { InventorySnapshot } from "./inventory.js";

const campaign = (id: string): Campaign => ({
  id,
  name: id,
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: 9_000,
  drops: [{
    id: `${id}-d`, name: "Crate", benefits: [{ name: "Crate", imageUrl: null }],
    requiredMinutes: 60, requiredSubs: 0,
  }],
});

function make(opts: {
  campaigns?: Campaign[];
  progress?: InventorySnapshot["progress"];
  earned?: InventorySnapshot["earned"];
  catalogueAvailable?: boolean;
  inventoryAvailable?: boolean;
} = {}) {
  const record = vi.fn(() => true);
  const recorder = new CampaignRecorder({
    catalogue: {
      get: async (): Promise<Catalogue> => ({
        campaigns: opts.campaigns ?? [], games: {}, fetchedAt: 1, stale: false,
        available: opts.catalogueAvailable ?? true, error: null,
      }),
    },
    inventory: {
      get: async (): Promise<InventorySnapshot> => ({
        progress: opts.progress ?? {}, earned: opts.earned ?? {}, links: {},
        fetchedAt: 1, available: opts.inventoryAvailable ?? true,
      }),
    },
    store: { record },
    now: () => 5_000,
  });
  return { recorder, record };
}

const inProgress = (cid: string, minutes = 30) => ({
  [cid]: { [`${cid}-d`]: { minutes, claimed: false, instanceId: null } },
});

test("records a campaign with progress, as it looks now", async () => {
  const { recorder, record } = make({
    campaigns: [campaign("c1")], progress: inProgress("c1"),
  });
  await recorder.pass();
  expect(record).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ id: "c1", status: "partial" }), 5_000,
  );
});

test("records a campaign whose rewards are all claimed", async () => {
  // Finished campaigns leave the in-progress map; the earned rewards are
  // what still say it was watched.
  const { recorder, record } = make({
    campaigns: [campaign("c1")], earned: { c1: ["Crate"] },
  });
  await recorder.pass();
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ id: "c1", status: "collected" }), 5_000,
  );
});

test("leaves out campaigns never watched", async () => {
  const { recorder, record } = make({ campaigns: [campaign("c1")] });
  await recorder.pass();
  expect(record).not.toHaveBeenCalled();
});

test("records nothing while progress cannot be read", async () => {
  // Every campaign resolves "unknown" then; a snapshot taken now would
  // overwrite a real one with a blank.
  const { recorder, record } = make({
    campaigns: [campaign("c1")], progress: inProgress("c1"), inventoryAvailable: false,
  });
  await recorder.pass();
  expect(record).not.toHaveBeenCalled();
});

test("records nothing without a campaign list", async () => {
  const { recorder, record } = make({
    campaigns: [campaign("c1")], progress: inProgress("c1"), catalogueAvailable: false,
  });
  await recorder.pass();
  expect(record).not.toHaveBeenCalled();
});
