import { afterEach, expect, test, vi } from "vitest";
import { UnauthorizedError, api } from "./client.js";

afterEach(() => { vi.unstubAllGlobals(); });

function stub(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("get returns parsed json", async () => {
  stub(200, { hello: "world" });
  await expect(api.get("/api/thing")).resolves.toEqual({ hello: "world" });
});

test("get sends credentials so the session cookie travels", async () => {
  const fetchMock = stub(200, {});
  await api.get("/api/thing");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });
});

test("a 401 raises UnauthorizedError so the gate can react", async () => {
  stub(401, { error: "unauthorized" });
  await expect(api.get("/api/thing")).rejects.toBeInstanceOf(UnauthorizedError);
});

test("a 400 raises an error carrying the server message", async () => {
  stub(400, { error: "duplicate streamer" });
  await expect(api.put("/api/config", {})).rejects.toThrow("duplicate streamer");
});

test("post sends a json body", async () => {
  const fetchMock = stub(200, {});
  await api.post("/api/session", { password: "x" });
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ password: "x" }));
});
