import "@testing-library/jest-dom/vitest";
import { render, within } from "@testing-library/react";
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
    const { container } = render(<InstallAppPanel state={{ ...baseState, canPrompt: true, install }} />);

    await user.click(within(container).getByRole("button", { name: "Install app", expanded: false }));
    expect(within(container).getByRole("button", { name: "Install app", expanded: true })).toBeInTheDocument();
    await user.click(within(container).getByRole("button", { name: "Install Plant Care" }));

    expect(install).toHaveBeenCalledOnce();
  });

  it("explains installed, insecure, iOS, and browser-menu states", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<InstallAppPanel state={{ ...baseState, installed: true }} />);
    expect(within(container).queryByText("Installed on this device.")).not.toBeVisible();
    await user.click(within(container).getByRole("button", { name: "Install app", expanded: false }));
    expect(within(container).getByText("Installed on this device.")).toBeInTheDocument();

    rerender(<InstallAppPanel state={{ ...baseState, isSecure: false }} />);
    expect(within(container).getByText(/requires an HTTPS address/i)).toBeInTheDocument();

    rerender(<InstallAppPanel state={{ ...baseState, isIos: true }} />);
    expect(within(container).getByText(/Add to Home Screen/i)).toBeInTheDocument();

    rerender(<InstallAppPanel state={baseState} />);
    expect(within(container).getByText(/Use your browser menu/i)).toBeInTheDocument();
  });
});
