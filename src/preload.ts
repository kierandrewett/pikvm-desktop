import { contextBridge, ipcRenderer } from "electron";

function injectCSS(css: string) {
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
}

function inject<T>(fn: (data?: T) => void, data?: T) {
    const s = document.createElement("script");
    s.textContent = `(${fn.toString()})(${JSON.stringify(data)});`;
    document.documentElement.appendChild(s);
    s.remove();
}

contextBridge.exposeInMainWorld("ui", {
    send: (c: string) => ipcRenderer.send(c),
    invoke: <T>(c: string, ...args: any[]): Promise<T> =>
        ipcRenderer.invoke(c, ...args),
    once: (c: string, cb: (...args: any[]) => void) =>
        ipcRenderer.once(c, (_, ...args) => cb(...args)),
    onState: (cb: (s: string) => void) =>
        ipcRenderer.on("window:state", (_, s) => cb(s)),
});

contextBridge.exposeInMainWorld("kvm", {
    async init() {
        console.log("Preload kvm init");

        ipcRenderer.once("kvm-css", (_, css: string) => {
            console.log("Preload injecting CSS");
            injectCSS(css);
        });

        const credentials = await ipcRenderer.invoke(
            "pikvm:autofill-credentials"
        );
        if (credentials) {
            console.log("Preload injecting autofill script");

            inject((credentialsRaw?: string) => {
                console.log("KVM autofill script running");

                const credentials = JSON.parse(credentialsRaw || "{}");

                const usernameInput = document.querySelector(
                    "input#user-input"
                ) as HTMLInputElement | null;
                const passwordInput = document.querySelector(
                    "input#passwd-input"
                ) as HTMLInputElement | null;

                if (usernameInput && passwordInput) {
                    usernameInput.value = credentials.username;
                    passwordInput.value = credentials.password;
                }
            }, JSON.stringify(credentials));
        }

        window.addEventListener("message", (e) => {
            if (e.data === "kvm:navigate-back") {
                console.log("Preload navigating back");

                ipcRenderer.send("navigate-back");
            }
        });

        inject(() => {
            let done = false;

            const run = () => {
                if (done) return;

                console.log("KVM init script running");

                const btn = document.querySelector(
                    "[data-wm-window-set-full-tab]"
                ) as HTMLButtonElement | null;

                if (btn) {
                    btn.click();
                }

                const backButton = document.querySelector("#navbar .left a");

                if (backButton) {
                    backButton.addEventListener("click", (e) => {
                        e.preventDefault();
                        window.postMessage("kvm:navigate-back", "*");
                    });
                }

                (globalThis as any).ui.onState(async (state: any) => {
                    console.log("KVM received window state:", state);
                    document.body.toggleAttribute(
                        "data-maximized",
                        state.isMaximized
                    );
                    document.body.setAttribute(
                        "data-theme",
                        state.theme || "light"
                    );
                });

                if (btn || backButton) {
                    done = true;
                }
            };

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", run);
            } else {
                run();
            }

            const obs = new MutationObserver(() => {
                run();
                obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
        });
    },
});
