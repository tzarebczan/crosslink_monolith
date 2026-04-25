/**
 * Electron main process entry. Owns the BrowserWindow lifecycle, the Sidecar
 * engine, and the IPC plumbing that wires the renderer to it.
 *
 * IPC contract is in `@shared/contracts.IPC`. Every channel name here must
 * match a key there; the `handle` and `on` calls do double-duty as
 * documentation of what payloads each direction carries.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  ConfigSchema,
  IPC,
  type Config,
  type LogEvent,
  type Status,
} from "@shared/contracts";
import { Sidecar } from "./sidecar";
import { loadConfig, saveConfig } from "./store";

let win: BrowserWindow | null = null;
let sidecar: Sidecar | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0b0d10",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false, // Electron's typed contextBridge needs this off
      contextIsolation: true,
    },
  });

  win.once("ready-to-show", () => win?.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function broadcast<T>(channel: string, payload: T): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function startSidecar(initial: Config): void {
  sidecar = new Sidecar(initial, {
    onStatus: (s: Status) => broadcast(IPC.StatusUpdate, s),
    onEvent: (e: LogEvent) => broadcast(IPC.EventAppended, e),
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.GetConfig, () => sidecar?.getConfig() ?? null);

  ipcMain.handle(IPC.SetConfig, (_evt, raw: unknown) => {
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.message };
    }
    const applied = sidecar?.applyConfig(parsed.data) ?? parsed.data;
    saveConfig(applied);
    return { ok: true, config: applied };
  });

  ipcMain.handle(IPC.GetStatus, () => sidecar?.getStatus() ?? null);
  ipcMain.handle(IPC.GetEvents, () => sidecar?.getEvents() ?? []);

  ipcMain.handle(IPC.ToggleAutoFaucet, () => {
    if (!sidecar) return null;
    const cfg = sidecar.toggleAutoFaucet();
    saveConfig(cfg);
    return cfg;
  });

  ipcMain.handle(IPC.ToggleAutoStake, () => {
    if (!sidecar) return null;
    const cfg = sidecar.toggleAutoStake();
    saveConfig(cfg);
    return cfg;
  });

  ipcMain.handle(IPC.TriggerFaucet, async () => sidecar?.triggerFaucet());
  ipcMain.handle(IPC.TriggerStake, async () => sidecar?.triggerStake());

  ipcMain.handle(IPC.PickFinalizer, async () => {
    if (!sidecar) return null;
    const cfg = await sidecar.pickRosterFinalizer();
    saveConfig(cfg);
    return cfg;
  });

  ipcMain.handle(IPC.WipeSnapshot, async () => sidecar?.wipeSnapshot());

  ipcMain.handle(IPC.RefreshNow, () => sidecar?.refreshNow());
}

app.whenReady().then(() => {
  registerIpc();
  startSidecar(loadConfig());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sidecar?.shutdown();
});
