import { describe, expect, test } from "bun:test";
import { ImageStore } from "../images/store";

function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, w);
  view.setUint32(20, h);
  return bytes;
}

function respond(body: Uint8Array, init?: ResponseInit): typeof fetch {
  return (async () => new Response(body as unknown as BodyInit, init)) as unknown as typeof fetch;
}

/** Resolve once the store reaches a terminal state for the requested URL. */
function settled(store: ImageStore, url: string): Promise<ReturnType<ImageStore["request"]>> {
  return new Promise((resolve) => {
    store.onChange(() => resolve(store.request(url)));
    store.request(url);
  });
}

describe("ImageStore", () => {
  test("a PNG becomes a ready entry with its intrinsic size", async () => {
    const store = new ImageStore(1, {}, respond(pngHeader(640, 480)));
    const entry = await settled(store, "https://x/y.png");
    expect(entry.state).toBe("ready");
    if (entry.state !== "ready") return;
    expect(entry.px).toEqual({ w: 640, h: 480 });
    expect(store.getById(entry.id)?.px).toEqual({ w: 640, h: 480 });
  });

  test("the first request returns loading rather than blocking", () => {
    const store = new ImageStore(1, {}, respond(pngHeader(1, 1)));
    expect(store.request("https://x/y.png").state).toBe("loading");
  });

  test("a repeat request never re-fetches — including after a failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const store = new ImageStore(1, {}, fetchImpl);
    const entry = await settled(store, "https://x/y.png");
    expect(entry.state).toBe("failed");
    // Lookups happen every frame; a retrying cache would be a request loop.
    for (let i = 0; i < 5; i++) store.request("https://x/y.png");
    expect(calls).toBe(1);
  });

  test("an HTTP error is reported with its status", async () => {
    const store = new ImageStore(1, {}, respond(new Uint8Array(0), { status: 403 }));
    const entry = await settled(store, "https://x/y.png");
    expect(entry).toMatchObject({ state: "failed", reason: "HTTP 403" });
  });

  test("an HTML page — the shape of a login redirect — fails as not an image", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html>sign in</html>");
    const store = new ImageStore(1, {}, respond(html));
    const entry = await settled(store, "https://x/y.png");
    expect(entry).toMatchObject({ state: "failed", reason: "not a recognised image" });
  });

  test("an SVG says so rather than claiming to be broken", async () => {
    const svg = new TextEncoder().encode(`<svg xmlns="x"><rect/></svg>`);
    const store = new ImageStore(1, {}, respond(svg));
    const entry = await settled(store, "https://x/y.svg");
    expect(entry).toMatchObject({ state: "failed", reason: "vector images aren't supported" });
  });

  test("a declared oversize body is refused before it is read", async () => {
    const store = new ImageStore(
      1,
      {},
      respond(pngHeader(1, 1), { headers: { "content-length": String(50 * 1024 * 1024) } }),
    );
    const entry = await settled(store, "https://x/y.png");
    expect(entry).toMatchObject({ state: "failed", reason: "image too large" });
  });

  test("a PNG with an unreadable header fails rather than being transmitted", async () => {
    const broken = pngHeader(1, 1);
    broken.set([0x49, 0x44, 0x41, 0x54], 12); // not IHDR
    const store = new ImageStore(1, {}, respond(broken));
    const entry = await settled(store, "https://x/y.png");
    expect(entry).toMatchObject({ state: "failed", reason: "unreadable PNG" });
  });

  test("a non-http URL is rejected without a network call", () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(pngHeader(1, 1) as unknown as BodyInit);
    }) as unknown as typeof fetch;
    const store = new ImageStore(1, {}, fetchImpl);
    expect(store.request("file:///etc/passwd")).toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
  });

  test("a thrown fetch becomes a failed entry, not an unhandled rejection", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const store = new ImageStore(1, {}, fetchImpl);
    const entry = await settled(store, "https://x/y.png");
    expect(entry).toMatchObject({ state: "failed", reason: "network down" });
  });

  test("ids are unique per image and namespaced by pid", async () => {
    const a = new ImageStore(100, {}, respond(pngHeader(2, 2)));
    const b = new ImageStore(200, {}, respond(pngHeader(2, 2)));
    const ea = await settled(a, "https://x/1.png");
    const eb = await settled(b, "https://x/1.png");
    expect(ea.state).toBe("ready");
    expect(eb.state).toBe("ready");
    if (ea.state !== "ready" || eb.state !== "ready") return;
    expect(ea.id).not.toBe(eb.id);
  });

  test("freed ids are drained exactly once", () => {
    const store = new ImageStore(1, {}, respond(pngHeader(2, 2)));
    expect(store.takeFreedIds()).toEqual([]);
  });
});
