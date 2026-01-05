import {
    app,
    BrowserWindow,
    WebContentsView,
    ipcMain,
    shell,
    screen,
    dialog,
    nativeTheme,
} from "electron";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { url } from "inspector/promises";
import { resolve } from "path";

const staticPath = resolve(__dirname, "static");

const configPath = resolve(app.getPath("userData"), "pikvm.json");
function loadConfig() {
    if (!existsSync(configPath)) {
        const cfg = { origin: "https://pikvm/" };
        writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        return cfg;
    }
    return JSON.parse(readFileSync(configPath, "utf-8"));
}
function saveConfig(cfg: any) {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function createWindow() {
    console.log("Creating window");

    const config = loadConfig();
    let origin = config.origin;

    const kvmSize = { width: 1280, height: 720 };
    const normalSize = { width: 400, height: 350 };
    const settingsSize = { width: 400, height: 110 };
    const TITLEBAR_HEIGHT = 38;

    const win = new BrowserWindow({
        width: normalSize.width,
        height: normalSize.height,
        darkTheme: true,
        frame: false,
        minWidth: 300,
        minHeight: 80,
        backgroundColor: "#0f0f14",
    });

    const mainView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload.js"),
        },
    });

    const overlayView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            preload: resolve(__dirname, "preload-ui.js"),
        },
    });

    let canCloseByButton = false;

    win.contentView.addChildView(overlayView);
    win.contentView.addChildView(mainView);

    const layout = () => {
        const [w, h] = win.getContentSize();
        console.log(`Layout: ${w}x${h}`);

        mainView.setBounds({
            x: 0,
            y: TITLEBAR_HEIGHT,
            width: w!,
            height: h! - TITLEBAR_HEIGHT,
        });

        overlayView.setBounds({
            x: 0,
            y: 0,
            width: w!,
            height: h!,
        });
    };

    win.on("resize", layout);
    layout();

    const wc = mainView.webContents;

    ipcMain.handle("pikvm:set-origin", async (_, newOrigin: string) => {
        if (!newOrigin.startsWith("http")) return false;

        config.origin = newOrigin.replace(/\/$/, "");
        saveConfig(config);
        origin = config.origin;

        console.log("New PiKVM origin:", origin);
        wc.loadURL(origin);
        return true;
    });

    ipcMain.handle("pikvm:connected-to-origin", () => {
        return wc.getURL().startsWith(origin);
    });
    ipcMain.handle("pikvm:get-origin", () => origin);

    const connect = () => {
        console.log("Connecting to PiKVM at:", origin);
        let parsedOrigin = new URL(origin);
        parsedOrigin.username = "";
        parsedOrigin.password = "";
        parsedOrigin.pathname = "/kvm";

        mainView.webContents.loadURL(parsedOrigin.toString());
    };

    ipcMain.on("pikvm:connect", () => {
        connect();
    });

    ipcMain.handle("pikvm:autofill-credentials", () => {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.username && parsedOrigin.password) {
            console.log("Autofill credentials found in origin URL");
            return {
                username: decodeURIComponent(parsedOrigin.username),
                password: decodeURIComponent(parsedOrigin.password),
            };
        }
        return null;
    });

    wc.setWindowOpenHandler(({ url }) => {
        console.log("Window open request:", url);

        const parsedOrigin = new URL(origin);
        const parsedURL = new URL(url);
        const isOrigin =
            parsedOrigin.host === parsedURL.host &&
            parsedOrigin.protocol === parsedURL.protocol &&
            parsedOrigin.port === parsedURL.port &&
            parsedOrigin.hostname === parsedURL.hostname;
        const isOriginAPI = isOrigin && parsedURL.pathname.startsWith("/api/");

        if (!isOrigin || isOriginAPI) {
            console.log("Opening externally");
            shell.openExternal(url);
            return { action: "deny" };
        }

        console.log("Allowed internally");
        return { action: "allow" };
    });

    wc.on("before-input-event", (_, input) => {
        if ((input.control || input.meta) && input.key.toLowerCase() === "w") {
            console.log("Blocked Ctrl/Cmd+W");
            return false;
        }
    });

    win.on("close", (e) => {
        const isOnKVMPage = wc.getURL().startsWith(origin + "/kvm");
        if (isOnKVMPage && !canCloseByButton) e.preventDefault();
    });

    wc.on("will-navigate", (e, url) => {
        console.log("Will navigate:", url);

        const parsedOrigin = new URL(origin);
        const parsedURL = new URL(url);
        const isOrigin =
            parsedOrigin.host === parsedURL.host &&
            parsedOrigin.protocol === parsedURL.protocol &&
            parsedOrigin.port === parsedURL.port &&
            parsedOrigin.hostname === parsedURL.hostname;
        const isOriginAPI = isOrigin && parsedURL.pathname.startsWith("/api/");

        if (!isOrigin || isOriginAPI) {
            console.log("External navigation blocked");
            e.preventDefault();
            shell.openExternal(url);
        }
    });

    function sendWindowState() {
        const state = {
            isMaximized: win.isMaximized(),
            canMaximize: canMaximize,
            canMinimize: win.isMinimizable(),
            title: wc.getTitle(),
            isFocused: win.isVisible() && isFocused && isCursorInWinBounds(),
            theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
        };

        overlayView.webContents.send("window:state", state);
        mainView.webContents.send("window:state", state);
    }

    let canMaximize = win.isMaximizable();

    wc.on("did-navigate", async (_, url) => {
        console.log("Navigated:", url);

        const isKVMPage = new URL(url).pathname.startsWith("/kvm");
        console.log("KVM page:", isKVMPage);

        await wc.executeJavaScript(`window.kvm?.init?.()`);
        sendWindowState();

        if (isKVMPage) {
            await wc.executeJavaScript(`window.kvm?.enter?.()`);
            canMaximize = true;
            win.setMaximizable(true);
            win.setClosable(false);

            console.log("Entering KVM mode");
            win.setSize(kvmSize.width, kvmSize.height);
            win.setResizable(true);

            console.log("KVM mode set");
        } else {
            console.log("Normal mode");

            if (
                url ===
                "file://" + resolve(__dirname, "views", "settings.html")
            ) {
                win.setSize(settingsSize.width, settingsSize.height);
                console.log(win.getSize());
            } else {
                win.setSize(normalSize.width, normalSize.height);
            }
            win.setResizable(false);

            canMaximize = false;
            win.setMaximizable(false);
            win.unmaximize();
            win.setClosable(true);
        }

        console.log("Injecting CSS");

        const cssData = [
            readFileSync(resolve(staticPath, "index.css"), "utf-8"),
            isKVMPage && readFileSync(resolve(staticPath, "kvm.css"), "utf-8"),
        ]
            .filter(Boolean)
            .join("\n");

        wc.send("kvm-css", cssData);

        sendWindowState();
    });

    ipcMain.on("window:minimise", () => {
        console.log("Minimise");
        win.minimize();
    });

    ipcMain.on("window:maximise", () => {
        console.log("Toggle maximise");
        win.isMaximized() ? win.unmaximize() : win.maximize();
    });

    ipcMain.on("window:close", () => {
        console.log("Close (UI)");
        canCloseByButton = true;
        win.close();
    });

    ipcMain.on("window:restore", () => {
        console.log("Restore");
        win.unmaximize();
    });

    ipcMain.on("navigate-back", () => {
        console.log("Navigate back");
        if (wc.navigationHistory.canGoBack()) {
            console.log("Going back in navigation history");
            wc.navigationHistory.goBack();
        } else {
            console.log("No navigation history to go back to");
        }
    });

    let isFocused = win.isFocused();

    function isCursorInWinBounds() {
        const cursorPos = screen.getCursorScreenPoint();
        const winBounds = win.getBounds();
        return (
            cursorPos.x >= winBounds.x &&
            cursorPos.x <= winBounds.x + winBounds.width &&
            cursorPos.y >= winBounds.y &&
            cursorPos.y <= winBounds.y + winBounds.height
        );
    }

    win.on("focus", () => {
        isFocused = true;
        sendWindowState();
    });
    win.on("blur", () => {
        isFocused = false;
        sendWindowState();
    });
    win.on("maximize", sendWindowState);
    win.on("unmaximize", sendWindowState);
    win.on("restore", sendWindowState);
    win.on("resize", sendWindowState);

    mainView.webContents.addListener("page-title-updated", sendWindowState);
    mainView.webContents.addListener("did-finish-load", sendWindowState);
    mainView.webContents.addListener("did-navigate", sendWindowState);
    mainView.webContents.addListener("did-navigate-in-page", sendWindowState);
    mainView.webContents.addListener("did-stop-loading", sendWindowState);
    mainView.webContents.addListener("did-frame-finish-load", sendWindowState);
    mainView.webContents.addListener("dom-ready", sendWindowState);
    mainView.addListener("bounds-changed", sendWindowState);
    mainView.webContents.addListener("focus", sendWindowState);
    mainView.webContents.addListener("blur", sendWindowState);
    mainView.webContents.addListener("paint", sendWindowState);
    mainView.webContents.addListener("frame-created", sendWindowState);
    mainView.webContents.addListener("zoom-changed", () => {
        mainView.webContents.setVisualZoomLevelLimits(1, 1);
        mainView.webContents.setZoomLevel(1);
    });

    nativeTheme.on("updated", () => {
        sendWindowState();
    });

    mainView.webContents.on("will-prevent-unload", (e) => {
        console.log("Unload prevented");
        e.preventDefault();
    });

    console.log("Loading overlay UI");
    overlayView.webContents.loadFile(resolve(__dirname, "views", "ui.html"));
    overlayView.webContents.setIgnoreMenuShortcuts(true);
    overlayView.webContents.setVisualZoomLevelLimits(1, 1);

    sendWindowState();

    mainView.webContents.loadFile(resolve(__dirname, "views", "settings.html"));

    mainView.webContents.addListener(
        "did-fail-load",
        (
            e,
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
            frameProcessId,
            frameRoutingId
        ) => {
            console.log("Main view failed to load");
            mainView.webContents.loadFile(
                resolve(__dirname, "views", "settings.html")
            );
            console.error(`Failed to load URL: ${validatedURL}`);
            console.error(e);
            dialog.showErrorBox(
                "Error",
                "Failed to load PiKVM interface.\n\nError code: " +
                    errorCode +
                    "\nDescription: " +
                    errorDescription +
                    "\nURL: " +
                    validatedURL +
                    "\n\nPlease check the PiKVM URL in settings."
            );
        }
    );

    if (
        process.env.NODE_ENV === "development" ||
        process.env.DEVTOOLS === "1"
    ) {
        overlayView.webContents.openDevTools({ mode: "detach" });
        mainView.webContents.openDevTools({ mode: "detach" });
    }

    mainView.webContents.focus();
}

app.whenReady().then(() => {
    console.log("Electron ready");
    app.commandLine.appendSwitch("ignore-certificate-errors");

    createWindow();
});
