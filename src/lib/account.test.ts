import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "./contracts";
import type { RemoteItem } from "./stremioApi";

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  postJson: vi.fn(),
  requestJson: vi.fn(),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock("./storage", () => ({
  storage: {
    getItem: (key: string) => mocks.values.get(key) ?? null,
    setItem: (key: string, value: string) => void mocks.values.set(key, value),
    removeItem: (key: string) => void mocks.values.delete(key),
  },
  flushStorage: () => Promise.resolve(),
}));
vi.mock("./transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("./transport")>(),
  postJson: mocks.postJson,
  requestJson: mocks.requestJson,
  getSecret: mocks.getSecret,
  setSecret: mocks.setSecret,
  deleteSecret: mocks.deleteSecret,
}));

const addon = "https://v3-cinemeta.strem.io/manifest.json";
const at = Date.parse("2026-11-01T00:00:00Z");
const movie = (id: string): MediaItem => ({ id, type: "movie", name: `Movie ${id}` });

function remote(id: string, mtime = at): RemoteItem {
  return {
    _id: id, name: `Remote ${id}`, type: "movie", removed: false, temp: false,
    _mtime: new Date(mtime).toISOString(),
    state: { timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup() {
  const [{ account }, { preferencesStore, mediaKey }] = await Promise.all([import("./account"), import("./store")]);
  return { account, store: preferencesStore, key: (id: string) => mediaKey("movie", id) };
}

describe("account store with the real synchronization planner", () => {
  let secret: string | null;
  let libraries: Record<string, RemoteItem[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(at);
    mocks.values.clear();
    mocks.values.set("vela.ui.language", "es");
    secret = null;
    libraries = {};
    mocks.getSecret.mockReset().mockImplementation(async () => secret);
    mocks.setSecret.mockReset().mockImplementation(async (_name: string, value: string) => { secret = value; });
    mocks.deleteSecret.mockReset().mockImplementation(async () => { secret = null; });
    mocks.requestJson.mockReset();
    mocks.postJson.mockReset().mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith("/login")) return { result: { authKey: "first", user: { _id: "first", email: "first@example.test" } } };
      if (url.endsWith("/getUser")) return { result: { _id: body.authKey, email: `${body.authKey}@example.test` } };
      if (url.endsWith("/datastoreGet")) return { result: libraries[String(body.authKey)] ?? [] };
      if (url.endsWith("/datastorePut")) return { result: { success: true } };
      if (url.endsWith("/logout")) return { result: {} };
      if (url.endsWith("/addonCollectionGet")) return { result: { addons: [] } };
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("signs in, merges remote titles, uploads local progress and signs out without deleting the library", async () => {
    const { account, store, key } = await setup();
    store.saveMedia(movie("local"), addon);
    store.updateProgress(movie("local"), addon, { videoId: "local", seconds: 42, duration: 100, updatedAt: at });
    libraries.first = [remote("cloud")];

    await account.signInWithPassword(" first@example.test ", "password");
    expect(mocks.postJson).toHaveBeenCalledWith(expect.stringContaining("/login"), expect.objectContaining({ email: "first@example.test" }));
    expect(mocks.setSecret).toHaveBeenCalledWith("stremio-auth-key", "first");
    expect(store.getSnapshot().library[key("cloud")].saved).toBe(true);
    expect(mocks.postJson).toHaveBeenCalledWith(expect.stringContaining("/datastorePut"), expect.objectContaining({
      authKey: "first", changes: [expect.objectContaining({ _id: "local", state: expect.objectContaining({ timeOffset: 42_000 }) })],
    }));
    expect(account.getSnapshot()).toMatchObject({ status: "signed-in", syncing: false, lastSync: { pulled: 1, pushed: 1 } });

    await account.signOut();
    expect(account.getSnapshot()).toMatchObject({ status: "signed-out", user: undefined, syncing: false, lastSync: undefined });
    expect(store.getSnapshot().library[key("local")].progress?.seconds).toBe(42);
    expect(store.getSnapshot().library[key("cloud")]).toBeDefined();
    expect(secret).toBeNull();
  });

  it("expires an invalid session while preserving local progress", async () => {
    const { account, store, key } = await setup();
    await account.signInWithKey("first");
    store.updateProgress(movie("local"), addon, { videoId: "local", seconds: 23, duration: 100, updatedAt: at });
    mocks.postJson.mockResolvedValueOnce({ error: { code: 1, message: "Session does not exist" } });

    await account.sync();
    expect(account.getSnapshot()).toMatchObject({ status: "signed-out", syncing: false, user: undefined, error: expect.stringContaining("caducado") });
    expect(store.getSnapshot().library[key("local")].progress?.seconds).toBe(23);
    expect(secret).toBeNull();
  });

  it("does not apply a late library response after signing out", async () => {
    const { account, store, key } = await setup();
    await account.signInWithKey("first");
    const response = deferred<{ result: RemoteItem[] }>();
    mocks.postJson.mockReturnValueOnce(response.promise);
    const sync = account.sync();
    await vi.waitFor(() => expect(account.getSnapshot().syncing).toBe(true));
    await Promise.resolve();
    await account.signOut();
    response.resolve({ result: [remote("late")] });
    await sync;

    expect(store.getSnapshot().library[key("late")]).toBeUndefined();
    expect(account.getSnapshot()).toMatchObject({ status: "signed-out", lastSync: undefined, syncing: false });
    expect(JSON.parse(mocks.values.get("vela.account.v1")!).user).toBeUndefined();
  });

  it.each([false, true])("invalidates a profile's in-flight response (switch back before it arrives: %s)", async (switchBack) => {
    const { account, store, key } = await setup();
    await account.signInWithKey("first");
    const response = deferred<{ result: RemoteItem[] }>();
    mocks.postJson.mockReturnValueOnce(response.promise);
    const sync = account.sync();
    await Promise.resolve();
    await Promise.resolve();
    store.switchProfile("other");
    if (switchBack) store.switchProfile("main");
    response.resolve({ result: [remote("late")] });
    await sync;
    expect(store.getSnapshot().library[key("late")]).toBeUndefined();
    expect(account.getSnapshot().syncing).toBe(false);
    store.switchProfile("main");
    expect(store.getSnapshot().library[key("late")]).toBeUndefined();
    expect(await account.sync()).toBeDefined();
  });

  it("keeps the latest account when an older synchronization finishes later", async () => {
    const { account, store, key } = await setup();
    await account.signInWithKey("first");
    const response = deferred<{ result: RemoteItem[] }>();
    mocks.postJson.mockReturnValueOnce(response.promise);
    const sync = account.sync();
    await Promise.resolve();
    await Promise.resolve();
    libraries.second = [remote("second-title")];
    await account.signInWithKey("second");
    response.resolve({ result: [remote("first-title")] });
    await sync;

    expect(account.getSnapshot()).toMatchObject({ status: "signed-in", user: { id: "second" }, syncing: false });
    expect(store.getSnapshot().library[key("first-title")]).toBeUndefined();
    expect(store.getSnapshot().library[key("second-title")]).toBeDefined();
    expect(secret).toBe("second");
  });

  it("does not let an expired response from an old account clear the new session", async () => {
    const { account } = await setup();
    await account.signInWithKey("first");
    const response = deferred<{ error: { code: number; message: string } }>();
    mocks.postJson.mockReturnValueOnce(response.promise);
    const sync = account.sync();
    await Promise.resolve();
    await Promise.resolve();
    await account.signInWithKey("second");
    response.resolve({ error: { code: 1, message: "Session does not exist" } });
    await sync;
    expect(account.getSnapshot()).toMatchObject({ status: "signed-in", user: { id: "second" }, error: undefined });
    expect(secret).toBe("second");
  });

  it("preserves edits made while a batch upload is pending", async () => {
    const { account, store, key } = await setup();
    await account.signInWithKey("first");
    store.saveMedia(movie("upload"), addon);
    store.saveMedia(movie("edited"), addon);
    libraries.first = [remote("edited", at + 1000)];
    const upload = deferred<{ result: { success: boolean } }>();
    const original = mocks.postJson.getMockImplementation()!;
    mocks.postJson.mockImplementation((url: string, body: Record<string, unknown>) => url.endsWith("/datastorePut") ? upload.promise : original(url, body));
    const sync = account.sync();
    await vi.waitFor(() => expect(mocks.postJson).toHaveBeenCalledWith(expect.stringContaining("/datastorePut"), expect.anything()));
    vi.mocked(Date.now).mockReturnValue(at + 2000);
    store.updateProgress(movie("edited"), addon, { videoId: "edited", seconds: 72, duration: 100, updatedAt: at + 2000 });
    upload.resolve({ result: { success: true } });
    await sync;

    expect(store.getSnapshot().library[key("edited")].progress?.seconds).toBe(72);
    mocks.postJson.mockImplementation(original);
    await account.sync();
    expect(account.getSnapshot().error).toBeUndefined();
    expect(mocks.postJson).toHaveBeenLastCalledWith(expect.stringContaining("/datastorePut"), expect.objectContaining({
      changes: expect.arrayContaining([expect.objectContaining({ _id: "edited", state: expect.objectContaining({ timeOffset: 72_000 }) })]),
    }));
  });

  it("retries failed uploads without losing local progress or deletions", async () => {
    const { account, store, key } = await setup();
    libraries.first = [remote("removed")];
    await account.signInWithKey("first");
    store.removeMedia("movie", "removed");
    store.updateProgress(movie("local"), addon, { videoId: "local", seconds: 56, duration: 100, updatedAt: at + 2000 });
    const original = mocks.postJson.getMockImplementation()!;
    mocks.postJson.mockImplementation((url: string, body: Record<string, unknown>) => url.endsWith("/datastorePut") ? Promise.reject(new Error("offline")) : original(url, body));
    await account.sync();
    expect(account.getSnapshot()).toMatchObject({ status: "signed-in", syncing: false, error: expect.stringContaining("offline") });
    expect(store.getSnapshot().library[key("local")].progress?.seconds).toBe(56);
    expect(JSON.parse(mocks.values.get("vela.account.v1")!).sync.removed.removed).toBeDefined();

    mocks.postJson.mockImplementation(original);
    await account.sync();
    expect(mocks.postJson).toHaveBeenLastCalledWith(expect.stringContaining("/datastorePut"), expect.objectContaining({
      changes: expect.arrayContaining([expect.objectContaining({ _id: "removed", removed: true }), expect.objectContaining({ _id: "local", state: expect.objectContaining({ timeOffset: 56_000 }) })]),
    }));
    expect(account.getSnapshot().error).toBeUndefined();
  });

  it("retains deletions made while an unrelated upload is pending", async () => {
    const { account, store } = await setup();
    libraries.first = [remote("removed")];
    await account.signInWithKey("first");
    store.saveMedia(movie("upload"), addon);
    const upload = deferred<{ result: { success: boolean } }>();
    const original = mocks.postJson.getMockImplementation()!;
    mocks.postJson.mockImplementation((url: string, body: Record<string, unknown>) => url.endsWith("/datastorePut") ? upload.promise : original(url, body));
    const sync = account.sync();
    await vi.waitFor(() => expect(mocks.postJson).toHaveBeenCalledWith(expect.stringContaining("/datastorePut"), expect.anything()));
    vi.mocked(Date.now).mockReturnValue(at + 2000);
    store.removeMedia("movie", "removed");
    upload.resolve({ result: { success: true } });
    await sync;
    expect(JSON.parse(mocks.values.get("vela.account.v1")!).sync.removed.removed).toBeDefined();

    mocks.postJson.mockImplementation(original);
    await account.sync();
    expect(mocks.postJson).toHaveBeenLastCalledWith(expect.stringContaining("/datastorePut"), expect.objectContaining({
      changes: expect.arrayContaining([expect.objectContaining({ _id: "removed", removed: true })]),
    }));
  });

  it("does not resurrect a password sign-in cancelled by signing out", async () => {
    const { account } = await setup();
    const response = deferred<{ result: { authKey: string; user: { _id: string; email: string } } }>();
    mocks.postJson.mockReturnValueOnce(response.promise);
    const signingIn = account.signInWithPassword("first@example.test", "password");
    await account.signOut();
    response.resolve({ result: { authKey: "first", user: { _id: "first", email: "first@example.test" } } });
    await signingIn;
    expect(account.getSnapshot()).toMatchObject({ status: "signed-out", user: undefined });
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(secret).toBeNull();
  });

  it("does not attach a pending sign-in to a profile selected later", async () => {
    const { account, store } = await setup();
    const response = deferred<{ result: { _id: string; email: string } }>();
    mocks.postJson.mockReturnValueOnce(response.promise);
    const signingIn = account.signInWithKey("first");
    store.switchProfile("other");
    response.resolve({ result: { _id: "first", email: "first@example.test" } });
    await signingIn;
    expect(account.profile()).toBeUndefined();
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });

  it("waits for an in-flight credential deletion before storing a new account", async () => {
    const { account } = await setup();
    await account.signInWithKey("first");
    const deletion = deferred<void>();
    mocks.deleteSecret.mockImplementationOnce(async () => { await deletion.promise; secret = null; });
    const signingOut = account.signOut();
    await vi.waitFor(() => expect(mocks.deleteSecret).toHaveBeenCalled());
    const signingIn = account.signInWithKey("second");
    deletion.resolve();
    await Promise.all([signingOut, signingIn]);
    expect(secret).toBe("second");
    expect(account.getSnapshot()).toMatchObject({ status: "signed-in", user: { id: "second" } });
  });

  it("keeps the account cache consistent if a profile changes during an OS credential write", async () => {
    const { account, store, key } = await setup();
    await account.signInWithKey("first");
    const writing = deferred<void>();
    mocks.setSecret.mockImplementationOnce(async (_name: string, value: string) => { await writing.promise; secret = value; });
    const signingIn = account.signInWithKey("second");
    await vi.waitFor(() => expect(mocks.setSecret).toHaveBeenCalledWith("stremio-auth-key", "second"));
    store.switchProfile("other");
    libraries.second = [remote("second-title")];
    writing.resolve();
    await signingIn;

    expect(secret).toBe("second");
    expect(account.getSnapshot()).toMatchObject({ user: { id: "second" } });
    expect(account.profile()).toBe("main");
    expect(store.getSnapshot().library[key("second-title")]).toBeUndefined();
    store.switchProfile("main");
    await account.sync();
    expect(store.getSnapshot().library[key("second-title")]).toBeDefined();
  });
});
