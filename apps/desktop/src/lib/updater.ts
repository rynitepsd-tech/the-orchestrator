/**
 * In-app updates.
 *
 * Checks the GitHub Releases `latest.json` feed (tauri-plugin-updater),
 * surfaces an "Update available" chip in the titlebar, and installs on click.
 * All failures are non-fatal: no endpoint / no network / dev builds simply
 * mean no chip.
 */

import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isActive, useStore } from "../store";

let pending: Update | null = null;

export async function checkForUpdates(opts: { silent: boolean }): Promise<void> {
  const st = useStore.getState();
  try {
    const update = await check();
    if (update) {
      pending = update;
      st.setUpdateAvailable({ version: update.version, notes: update.body ?? undefined });
    } else {
      pending = null;
      st.setUpdateAvailable(undefined);
      if (!opts.silent) {
        await message("You're on the latest version.", { title: "The Orchestrator" });
      }
    }
  } catch (e) {
    // Expected in dev builds and before the release feed exists.
    if (!opts.silent) {
      await message(`Could not check for updates: ${String((e as Error)?.message ?? e)}`, {
        title: "The Orchestrator",
        kind: "warning",
      });
    }
  }
}

export async function installUpdate(): Promise<void> {
  const st = useStore.getState();
  if (!pending || st.updateBusy) return;
  st.setUpdateBusy(true);
  try {
    // The chip may be hours old and more releases may have shipped since.
    // Re-check at click time so one install always lands on the LATEST
    // version — never a stale middle release that asks for a second update.
    const update = (await check().catch(() => null)) ?? pending;
    pending = update;
    st.setUpdateAvailable({ version: update.version, notes: update.body ?? undefined });
    await update.downloadAndInstall();
    st.setUpdateBusy(false);
    const running = Object.values(st.sessions).filter((v) => isActive(v.summary.runState)).length;
    const restart = await ask(
      running > 0
        ? `Update ${update.version} is installed. Restarting now will stop ${running} running session${running === 1 ? "" : "s"}. Restart?`
        : `Update ${update.version} is installed. Restart now?`,
      { title: "The Orchestrator", kind: "info" },
    );
    if (restart) await relaunch();
  } catch (e) {
    st.setUpdateBusy(false);
    await message(`Update failed: ${String((e as Error)?.message ?? e)}`, {
      title: "The Orchestrator",
      kind: "error",
    });
  }
}
