import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ui", {
    send: (c: string) => ipcRenderer.send(c),
    invoke: <T>(c: string, ...args: any[]): Promise<T> =>
        ipcRenderer.invoke(c, ...args),
    once: (c: string, cb: (...args: any[]) => void) =>
        ipcRenderer.once(c, (_, ...args) => cb(...args)),
    onState: (cb: (s: string) => void) =>
        ipcRenderer.on("window:state", (_, s) => cb(s)),
});
