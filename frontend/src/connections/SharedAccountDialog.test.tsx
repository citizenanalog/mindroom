import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAccountDialog } from "./SharedAccountDialog";

afterEach(cleanup);

const renderDialog = (open = true) => {
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <SharedAccountDialog
      open={open}
      agent="Shared Dev"
      provider="Google"
      onContinue={onContinue}
      onCancel={onCancel}
    />,
  );
  return { onContinue, onCancel, view };
};

describe("shared account dialog", () => {
  it("asks in the words of the spec and offers Continue and Cancel", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: "Connect a shared account?" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Everyone who uses Shared Dev will act as the Google account you pick. Use a team account, not your personal one.",
      ),
    ).toBeVisible();
  });

  it("goes on once however often Continue is clicked while the dialog stays open", () => {
    const { onContinue } = renderDialog();
    const button = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("goes on again when it is opened anew", () => {
    const { onContinue, view } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    view.rerender(
      <SharedAccountDialog
        open={false}
        agent="Shared Dev"
        provider="Google"
        onContinue={onContinue}
        onCancel={vi.fn()}
      />,
    );
    view.rerender(
      <SharedAccountDialog
        open
        agent="Shared Dev"
        provider="Google"
        onContinue={onContinue}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(2);
  });

  it("cancels without going on", () => {
    const { onContinue, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });
});
