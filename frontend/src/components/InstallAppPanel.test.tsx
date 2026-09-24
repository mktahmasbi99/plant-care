import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InstallAppPanel, type PwaInstallState } from "./InstallAppPanel";

const baseState: PwaInstallState = {
  canPrompt: false,
  install: vi.fn(() => Promise.resolve()),
  installed: false,
  isIos: false,
  isSecure: true,
};

describe("InstallAppPanel", () => {
  it("runs the browser install prompt from its explicit button", async () => {
    const install = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    render(<InstallAppPanel state={{ ...baseState, canPrompt: true, install }} />);

    await user.click(screen.getByRole("button", { name: "Install Plant Care" }));

    expect(install).toHaveBeenCalledOnce();
  });

  it("explains installed, insecure, iOS, and browser-menu states", () => {
    const { rerender } = render(<InstallAppPanel state={{ ...baseState, installed: true }} />);
    expect(screen.getByText("Installed on this device.")).toBeInTheDocument();

    rerender(<InstallAppPanel state={{ ...baseState, isSecure: false }} />);
    expect(screen.getByText(/requires an HTTPS address/i)).toBeInTheDocument();

    rerender(<InstallAppPanel state={{ ...baseState, isIos: true }} />);
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument();

    rerender(<InstallAppPanel state={baseState} />);
    expect(screen.getByText(/Use your browser menu/i)).toBeInTheDocument();
  });
});
