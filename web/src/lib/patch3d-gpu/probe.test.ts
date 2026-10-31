import { afterEach, describe, expect, it, vi } from "vitest";
import { gpuAdvice, gpuLimits, gpuProbe, isLinux } from "./index";

const limits = { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 31 };
const fakeAdapter = (device: () => Promise<unknown>) => ({
  limits, info: { vendor: "acme", architecture: "rdna", description: "" }, requestDevice: vi.fn(device),
});
const okDevice = () => Promise.resolve({ destroy: vi.fn() });

function stubGpu(requestAdapter: (opts?: GPURequestAdapterOptions) => Promise<unknown>) {
  const gpu = { requestAdapter: vi.fn(requestAdapter) };
  vi.stubGlobal("navigator", { gpu });
  return gpu;
}

describe("gpuProbe", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("no-api: no navigator.gpu", async () => {
    vi.stubGlobal("navigator", {});
    expect(await gpuProbe()).toEqual({ reason: "no-api", limits: null });
    expect(await gpuLimits()).toBeNull();
  });

  it("no-adapter: both adapter requests answer null, the second without powerPreference", async () => {
    const gpu = stubGpu(async () => null);
    expect(await gpuProbe()).toEqual({ reason: "no-adapter", limits: null });
    expect(gpu.requestAdapter.mock.calls).toEqual([[{ powerPreference: "high-performance" }], [undefined]]);
  });

  it("a throwing adapter request counts as no adapter", async () => {
    stubGpu(async () => { throw new Error("blocked by policy"); });
    expect((await gpuProbe()).reason).toBe("no-adapter");
  });

  it("ok: falls back to any adapter when high-performance answers null", async () => {
    const ad = fakeAdapter(okDevice);
    const gpu = stubGpu(async (opts) => (opts?.powerPreference ? null : ad));
    const p = await gpuProbe();
    expect(p.reason).toBe("ok");
    expect(p.limits).toEqual({ maxBuffer: 2 ** 30, description: "acme rdna" });
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(2);
  });

  it("ok on the first request does not ask twice, and the probe device is released", async () => {
    const device = { destroy: vi.fn() };
    const ad = fakeAdapter(async () => device);
    const gpu = stubGpu(async () => ad);
    expect((await gpuProbe()).reason).toBe("ok");
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
    expect(device.destroy).toHaveBeenCalled();
  });

  it("device-lost: an adapter whose device cannot be opened", async () => {
    stubGpu(async () => fakeAdapter(async () => { throw new Error("device lost"); }));
    expect(await gpuProbe()).toEqual({ reason: "device-lost", limits: null });
  });
});

const EDGE_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

describe("isLinux", () => {
  it("reads userAgentData.platform first, then the user agent", () => {
    expect(isLinux({ userAgentData: { platform: "Linux" }, userAgent: EDGE_WIN })).toBe(true);
    expect(isLinux({ userAgentData: { platform: "Windows" }, userAgent: EDGE_LINUX })).toBe(false);
    expect(isLinux({ userAgent: EDGE_LINUX })).toBe(true);
    expect(isLinux({ userAgent: EDGE_WIN })).toBe(false);
    expect(isLinux({ userAgent: ANDROID })).toBe(false);
    expect(isLinux(undefined)).toBe(false);
  });
});

describe("gpuAdvice", () => {
  it("Linux without WebGPU points at the flags", () => {
    for (const reason of ["no-api", "no-adapter"] as const) {
      expect(gpuAdvice(reason, true).help).toContain("edge://flags");
      expect(gpuAdvice(reason, true).help).toContain("Unsafe WebGPU Support and Vulkan");
    }
  });

  it("Windows and Mac get the browser and acceleration advice", () => {
    expect(gpuAdvice("no-api", false).help).toBe("This browser has no WebGPU. Use a current Chrome or Edge on Windows or Mac.");
    expect(gpuAdvice("no-adapter", false).help).toContain("Turn on graphics acceleration");
    expect(gpuAdvice("no-adapter", false).help).not.toContain("flags");
  });

  it("device-lost is the same everywhere, and ok has no help line", () => {
    expect(gpuAdvice("device-lost", true)).toEqual(gpuAdvice("device-lost", false));
    expect(gpuAdvice("ok", true).help).toBe("");
  });

  it("detects the platform from navigator by default", () => {
    vi.stubGlobal("navigator", { userAgent: EDGE_LINUX });
    expect(gpuAdvice("no-api").help).toContain("edge://flags");
    vi.stubGlobal("navigator", { userAgent: EDGE_WIN });
    expect(gpuAdvice("no-api").help).not.toContain("flags");
    vi.unstubAllGlobals();
  });
});
