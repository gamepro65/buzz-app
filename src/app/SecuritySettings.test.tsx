// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecuritySettings } from "./SecuritySettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const tool = {
  id: "p1",
  client: "buzz-cli",
  relay: "wss://relay.example/",
  created: 1_800_000_000,
  lastUsed: 1_800_000_000,
  expires: 1_802_592_000,
};
const other = { ...tool, id: "p2", client: "notes", relay: "wss://other/" };
const revoked = ["credential_pairing_revoke", expect.anything()] as const;
beforeEach(() => {
  vi.mocked(listen).mockResolvedValue(() => {});
});
afterEach(cleanup);

/** Clicks a row's Revoke and returns the confirmation it opens. */
async function ask(revoke: HTMLElement | undefined, client: string) {
  if (!revoke) throw new Error("No Revoke button");
  // Only this click is judged; an earlier confirmed revoke may have run.
  vi.mocked(invoke).mockClear();
  await userEvent.click(revoke);
  expect(invoke).not.toHaveBeenCalledWith(...revoked);
  const dialog = screen.getByRole("alertdialog", { name: `Revoke ${client}?` });
  expect(dialog).toHaveTextContent(
    "It stops working until you pair it again with buzz auth desktop pair.",
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  return dialog;
}

it("lists paired tools and revokes one after asking", async () => {
  let release = () => {};
  vi.mocked(invoke).mockImplementation((command) =>
    command === "credential_pairings_list"
      ? Promise.resolve([tool, other])
      : new Promise<void>((resolve) => {
          release = resolve;
        }),
  );
  render(<SecuritySettings />);
  expect(await screen.findByText("buzz-cli")).toBeInTheDocument();
  expect(
    screen.getByText(/wss:\/\/relay\.example\/ · Paired/),
  ).toBeInTheDocument();
  const [first] = screen.getAllByRole("button", { name: "Revoke" });
  const dialog = await ask(first, "buzz-cli");
  const confirm = within(dialog).getByRole("button", { name: "Revoke" });
  await userEvent.click(confirm);
  expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
    id: "p1",
  });
  // The dialog holds while native works, with Revoke busy and Cancel disabled.
  expect(confirm).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  release();
  await waitFor(() => expect(screen.queryByText("buzz-cli")).toBeNull());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // Focus moves to the next row's Revoke, not body.
  const next = screen.getByRole("button", { name: "Revoke" });
  await waitFor(() => expect(next).toHaveFocus());
  // Revoking the last tool keeps focus in this section.
  await userEvent.click(
    within(await ask(next, "notes")).getByRole("button", { name: "Revoke" }),
  );
  release();
  expect(await screen.findByText("No paired tools")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Security" })).toHaveFocus(),
  );
});

it("cancels without revoking and returns focus to the row's Revoke", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "credential_pairings_list" ? [tool] : undefined,
  );
  render(<SecuritySettings />);
  const revoke = await screen.findByRole("button", { name: "Revoke" });
  await userEvent.click(
    within(await ask(revoke, "buzz-cli")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(revoke).toHaveFocus());
  await ask(revoke, "buzz-cli");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(revoke).toHaveFocus());
  expect(invoke).not.toHaveBeenCalledWith(...revoked);
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
});

it("keeps the row and the open dialog, and says why, when revoking fails", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "credential_pairings_list") return [tool];
    throw "Paired tools could not be saved to secure storage";
  });
  render(<SecuritySettings />);
  const revoke = await screen.findByRole("button", { name: "Revoke" });
  const dialog = await ask(revoke, "buzz-cli");
  await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  // One alert, inside the dialog; the row stays.
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  expect(dialog).toBeInTheDocument();
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
  await waitFor(() => expect(revoke).toHaveFocus());
});

it("shows an empty state, and a read failure", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([]);
  render(<SecuritySettings />);
  expect(await screen.findByText("No paired tools")).toBeInTheDocument();
  expect(screen.queryByText("Authorize external identity")).toBeNull();
  cleanup();
  vi.mocked(invoke).mockRejectedValueOnce(
    "Paired tools could not be read from secure storage",
  );
  render(<SecuritySettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be read",
  );
});
