/**
 * Preload — runs in the bridge between the renderer and main process. Exposes
 * a tiny typed surface area to `window.sidecar` via contextBridge so the
 * renderer never sees raw `ipcRenderer` and can't trivially be tricked into
 * invoking arbitrary IPC channels.
 *
 * The renderer imports the type via `@shared/contracts` for compile-time
 * checks; runtime safety still comes from the Zod parses on the main side.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type Config,
  type LogEvent,
  type Status,
} from "@shared/contracts";

type Unsubscribe = () => void;

function subscribe<T>(
  channel: string,
  handler: (payload: T) => void,
): Unsubscribe {
  const wrapped = (_e: IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api = {
  getConfig: (): Promise<Config | null> => ipcRenderer.invoke(IPC.GetConfig),
  setConfig: (
    cfg: Config,
  ): Promise<{ ok: true; config: Config } | { ok: false; message: string }> =>
    ipcRenderer.invoke(IPC.SetConfig, cfg),

  getStatus: (): Promise<Status | null> => ipcRenderer.invoke(IPC.GetStatus),
  getEvents: (): Promise<LogEvent[]> => ipcRenderer.invoke(IPC.GetEvents),

  toggleAutoFaucet: (): Promise<Config | null> =>
    ipcRenderer.invoke(IPC.ToggleAutoFaucet),
  toggleAutoStake: (): Promise<Config | null> =>
    ipcRenderer.invoke(IPC.ToggleAutoStake),

  triggerFaucet: (): Promise<{ ok: boolean; message: string } | undefined> =>
    ipcRenderer.invoke(IPC.TriggerFaucet),
  triggerStake: (): Promise<{ ok: boolean; message: string } | undefined> =>
    ipcRenderer.invoke(IPC.TriggerStake),

  pickFinalizer: (): Promise<Config | null> =>
    ipcRenderer.invoke(IPC.PickFinalizer),

  wipeSnapshot: (): Promise<{ ok: boolean; message: string } | undefined> =>
    ipcRenderer.invoke(IPC.WipeSnapshot),

  refreshNow: (): Promise<void> => ipcRenderer.invoke(IPC.RefreshNow),

  onStatus: (handler: (s: Status) => void): Unsubscribe =>
    subscribe(IPC.StatusUpdate, handler),
  onEvent: (handler: (e: LogEvent) => void): Unsubscribe =>
    subscribe(IPC.EventAppended, handler),
};

contextBridge.exposeInMainWorld("sidecar", api);

export type SidecarApi = typeof api;
