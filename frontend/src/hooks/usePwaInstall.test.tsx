import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BeforeInstallPromptEvent, usePwaInstall } from "./usePwaInstall";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("usePwaInstall", () => {
  it("captures and runs Chromium's deferred install prompt", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" }),
    }) as BeforeInstallPromptEvent;
    const { result } = renderHook(() => usePwaInstall());

    act(() => window.dispatchEvent(event));
    expect(result.current.canPrompt).toBe(true);

    await act(() => result.current.install());
    expect(prompt).toHaveBeenCalledOnce();
    expect(result.current.canPrompt).toBe(false);
  });

  it("recognizes standalone display mode as installed", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    const { result } = renderHook(() => usePwaInstall());

    expect(result.current.installed).toBe(true);
  });
});
