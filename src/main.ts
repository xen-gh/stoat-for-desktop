import fs from "node:fs";
import path from "node:path";
import { IUpdateInfo, updateElectronApp } from "update-electron-app";

import { BrowserWindow, Notification, app, shell, globalShortcut } from "electron";
import started from "electron-squirrel-startup";

import { initAutoLaunch } from "./native/autoLaunch";
import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import {
  cleanupPushToTalk,
  initPushToTalk,
  registerPushToTalkHotkey,
} from "./native/pushToTalk";
import { initTray } from "./native/tray";
import { cleanupVirtualMic, initVirtualMic } from "./native/virtualMic";
import {
  BUILD_URL,
  createMainWindow,
  initBuildUrl,
  mainWindow,
} from "./native/window";

/// TODO WAYLAND-PTT
import * as dbus from "@homebridge/dbus-native";
import { randomUUID } from "node:crypto";
import { MessageBus } from "@homebridge/dbus-native";
import EventEmitter from "node:events";

type RuntimeMessageBus = MessageBus & {
  addMatch(
    match: string,
    callback: (error: Error | null, result?: unknown) => void,
  ): void;
  removeMatch(
    match: string,
    callback?: (error: Error | null, result?: unknown) => void,
  ): void;
  mangle(path: string, iface: string, member: string): string;
  signals: EventEmitter;
};
///

// In Flatpak, we have to update the temp dir to a shared directory across host and sandbox;
// otherwise, the icon will not show up in the tray when using app indicators.
if (process.platform === "linux" && process.env.FLATPAK_ID) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    try {
      const sharedTmpDir = path.join(runtimeDir, "app", process.env.FLATPAK_ID);
      fs.mkdirSync(sharedTmpDir, { recursive: true });
      process.env.TMPDIR = sharedTmpDir;
    } catch (error) {
      console.error("Failed to set up host-visible TMPDIR:", error);
    }
  }
}

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

const onNotifyUser = (_info: IUpdateInfo) => {
  const notification = new Notification({
    title: "Update Available",
    body: "Restart the app to install the update.",
    silent: true,
  });

  notification.show();
};

if (acquiredLock) {
  // start auto update logic
  updateElectronApp({ onNotifyUser });

  app.on("ready", () => {
    // initialise build URL from command line
    initBuildUrl();

    // TODO
    const isLinuxWayland =
      process.platform === "linux" &&
      Boolean(process.env.WAYLAND_DISPLAY);

    if (isLinuxWayland) {
      console.log("[************************************************************]");
      var ptt_shortcut_id = "ptt_trigger_v4"
      app.setDesktopName("chat.stoat.StoatDesktop");

      const dbusWithSessionBus = dbus as typeof dbus & {
        sessionBus: (options?: { timeout?: number }) => typeof dbus extends never
          ? never
          : ReturnType<typeof dbus.systemBus>;
      };
      const bus = dbusWithSessionBus.sessionBus({ timeout: 10000 });
      const runtimeBus = bus as RuntimeMessageBus;

      runtimeBus.connection.on("error", (error: Error) => {
        console.log("[PTT-WAYLAND] D-Bus connection error:", error.message);
      });

      console.log("[PTT-WAYLAND] Registering Host Application ID...");
      bus.invoke({
        destination: 'org.freedesktop.portal.Desktop',
        path: '/org/freedesktop/portal/desktop',
        interface: 'org.freedesktop.portal.Flatpak',
        member: 'Register',
        signature: 'sa{sv}',
        body: [
          "chat.stoat.StoatDesktop", // AppID for gnome portal reg
          []
        ]
      }, (regError) => {
        if (regError) {
          console.warn("[PTT-WAYLAND] Host registration warning:", regError.message);
        } else {
          console.log("[PTT-WAYLAND] Host application successfully registered with GNOME Portal.");
        }


        const service = runtimeBus.getService("org.freedesktop.portal.Desktop");

        service.getObject(
          "/org/freedesktop/portal/desktop",
          (objectError, portalObject) => {
            if (objectError || !portalObject) {
              console.error(
                "[PTT-WAYLAND] Failed to get portal object:",
                objectError?.message ?? "No object returned",
              );
              return;
            }

            const portal = portalObject.as(
              "org.freedesktop.portal.GlobalShortcuts",
            );

            console.log("[PTT-WAYLAND] Portal interface acquired");

            // CreateSession implementation
            const token = `stoat_ptt_${randomUUID().replace(/-/g, "")}`;
            const sessionToken = `stoat_session_${randomUUID().replace(/-/g, "")}`;

            // dbus-native sets runtimeBus.name from the Hello reply.
            const uniqueName = (bus as typeof bus & { name?: string }).name;

            if (!uniqueName || !uniqueName.startsWith(":")) {
              console.error("[PTT-WAYLAND] D-Bus unique name is not ready:", uniqueName);
              return;
            }

            const sender = uniqueName.slice(1).replace(/\./g, "_");
            const requestPath =
              `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

            const requestInterface = "org.freedesktop.portal.Request";
            const responseMember = "Response";

            const matchRule = [
              "type='signal'",
              "sender='org.freedesktop.portal.Desktop'",
              `path='${requestPath}'`,
              `interface='${requestInterface}'`,
              `member='${responseMember}'`,
            ].join(",");

            runtimeBus.addMatch(matchRule, (matchError: Error | null) => {
              if (matchError) {
                console.error(
                  "[PTT-WAYLAND] Failed to subscribe to Response:",
                  matchError.message,
                );
                return;
              }

              const signalKey = runtimeBus.mangle(
                requestPath,
                requestInterface,
                responseMember,
              );

              const onResponse = (
                body: [number, Record<string, unknown>],
              ) => {
                runtimeBus.signals.removeListener(signalKey, onResponse);

                const [response, results] = body;

                console.log("[PTT-WAYLAND] CreateSession response:", {
                  response,
                  results,
                });

                if (response !== 0) {
                  console.error("[PTT-WAYLAND] CreateSession failed:", response);
                  return;
                }

                let sessionHandle: string | undefined;

                if (Array.isArray(results)) {
                  const sessionEntry = results.find(entry => Array.isArray(entry) && entry[0] === 'session_handle');

                  if (sessionEntry && Array.isArray(sessionEntry[1]) && Array.isArray(sessionEntry[1][1])) {
                    sessionHandle = sessionEntry[1][1][0]; // this works now but may break on newer GNOME versions
                  }
                } else if (results && typeof results.session_handle === 'string') {
                  sessionHandle = results.session_handle;
                }

                if (!sessionHandle || typeof sessionHandle !== "string") {
                  console.error("[PTT-WAYLAND] Missing session_handle. Raw results:", JSON.stringify(results));
                  return;
                }

                console.log("[PTT-WAYLAND] Session created successfully:", sessionHandle);

                const shortcutToken = `stoat_shortcut_${randomUUID().replace(/-/g, "")}`;
                const shortcutRequestPath = `/org/freedesktop/portal/desktop/request/${sender}/${shortcutToken}`;

                const shortcutMatchRule = [
                  "type='signal'",
                  "sender='org.freedesktop.portal.Desktop'",
                  `path='${shortcutRequestPath}'`,
                  `interface='${requestInterface}'`,
                  `member='${responseMember}'`,
                ].join(",");

                // BindShortcuts subscribe
                runtimeBus.addMatch(shortcutMatchRule, (shortcutMatchError: Error | null) => {
                  if (shortcutMatchError) {
                    console.error("[PTT-WAYLAND] Failed to subscribe to Shortcut Response:", shortcutMatchError.message);
                    return;
                  }

                  const shortcutSignalKey = runtimeBus.mangle(
                    shortcutRequestPath,
                    requestInterface,
                    responseMember
                  );

                  const onShortcutResponse = (shortcutBody: [number, Record<string, unknown>]) => {
                    runtimeBus.signals.removeListener(shortcutSignalKey, onShortcutResponse);
                    const [shortcutResponse, shortcutResults] = shortcutBody;

                    console.log("[PTT-WAYLAND] BindShortcuts response status:", shortcutResponse);

                    if (shortcutResponse !== 0) {
                      console.error("[PTT-WAYLAND] BindShortcuts failed or rejected by user.");
                      return;
                    }

                    console.log("[PTT-WAYLAND] Global shortcuts bound successfully! Listening for PTT triggers...");
                  };

                  runtimeBus.signals.on(shortcutSignalKey, onShortcutResponse);

                  // DBUS registration
                  const filterRule = `type='signal',sender='org.freedesktop.portal.Desktop',interface='org.freedesktop.portal.GlobalShortcuts',path='${sessionHandle}'`;

                  bus.invoke({
                    destination: 'org.freedesktop.DBus',
                    path: '/org/freedesktop/DBus',
                    interface: 'org.freedesktop.DBus',
                    member: 'AddMatch',
                    signature: 's',
                    body: [filterRule]
                  }, (matchErr) => {
                    if (matchErr) {
                      console.error("[PTT-WAYLAND] Failed to force D-Bus AddMatch:", matchErr.message);
                    } else {
                      console.log("[PTT-WAYLAND] D-Bus server match rule established for session path.");
                    }
                  });

                  // message handler
                  runtimeBus.connection.on('message', (msg) => {
                    if (msg.interface === 'org.freedesktop.portal.GlobalShortcuts') {
                      const bodyStr = JSON.stringify(msg.body || "");
                      const isPttTrigger = bodyStr.includes(ptt_shortcut_id);

                      if (msg.member === 'Activated' && isPttTrigger) {
                        console.log("[PTT-WAYLAND] PTT Pressed -> UNMUTE MICROPHONE");
                        if (mainWindow && !mainWindow.isDestroyed()) {
                          mainWindow.webContents.send("ptt-state-change", "ON");
                        }
                      }
                      else if (msg.member === 'Deactivated' && isPttTrigger) {
                        console.log("[PTT-WAYLAND] PTT Released -> MUTE MICROPHONE");
                        if (mainWindow && !mainWindow.isDestroyed()) {
                          mainWindow.webContents.send("ptt-state-change", "OFF");
                        }
                      }
                    }
                  });

                  // BindShortcuts
                  bus.invoke(
                    {
                      destination: 'org.freedesktop.portal.Desktop',
                      path: '/org/freedesktop/portal/desktop',
                      interface: 'org.freedesktop.portal.GlobalShortcuts',
                      member: 'BindShortcuts',
                      signature: 'oa(sa{sv})sa{sv}', // portal requested signature
                      body: [
                        sessionHandle,                      // o -> Object path
                        [                                   // a(sa{sv}) -> hotkeys
                          [                                 // (...) -> Shortcut signature
                            ptt_shortcut_id,                // s -> Shortcut ID
                            [                               // a{sv} -> Shortcut properties
                              ["description", ["s", "Stoat Desktop Push-to-Talk"]],
                              ["preferred_trigger", ["s", "Caps_Lock"]]
                              //["preferred_trigger", ["s", "F10"]]
                            ]
                          ]
                        ],
                        "chat.stoat.StoatDesktop",          // s -> App ID (A tömb UTÁN következik!)
                        [                                   // a{sv} -> Globális opciók szótára
                          ['handle_token', ['s', shortcutToken]]
                        ]
                      ]
                    },
                    (callError: Error | null, actualShortcutPath: string) => {
                      if (callError) {
                        runtimeBus.signals.removeListener(shortcutSignalKey, onShortcutResponse);
                        console.error("[PTT-WAYLAND] BindShortcuts call failed:", callError.message);
                        return;
                      }
                      console.log("[PTT-WAYLAND] BindShortcuts invocation sent. Waiting for user authorization...");
                    }
                  );
                });
              };

              // Register the local listener only after AddMatch succeeds,
              // but before issuing CreateSession.
              runtimeBus.signals.on(signalKey, onResponse);

              bus.invoke(
                {
                  destination: 'org.freedesktop.portal.Desktop',
                  path: '/org/freedesktop/portal/desktop',
                  interface: 'org.freedesktop.portal.GlobalShortcuts',
                  member: 'CreateSession',
                  signature: 'a{sv}',
                  body: [
                    [
                      ['handle_token', ['s', token]],
                      ['session_handle_token', ['s', sessionToken]]
                    ]
                  ]
                },
                (callError: Error | null, actualPath: string) => {
                  if (callError) {
                    runtimeBus.signals.removeListener(signalKey, onResponse);
                    console.error(
                      "[PTT-WAYLAND] CreateSession call failed:",
                      callError.message,
                    );
                    return;
                  }

                  if (actualPath !== requestPath) {
                    runtimeBus.signals.removeListener(signalKey, onResponse);
                    console.error("[PTT-WAYLAND] Unexpected request path:", {
                      expected: requestPath,
                      actual: actualPath,
                    });
                  } else {
                    console.log("[PTT-WAYLAND] Waiting for Response on:", actualPath);
                  }
                }
              );

            });
            //
          },
        );
      });
    }
    //

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    // create window and application contexts
    createMainWindow();
    initTray();
    // initDiscordRpc();
    initPushToTalk();
    initVirtualMic();
    initAutoLaunch();

    // Windows specific fix for notifications
    if (process.platform === "win32") {
      app.setAppUserModelId("chat.stoat.notifications");
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    cleanupPushToTalk();
    if (process.platform !== "darwin") {
      cleanupVirtualMic();
      // Only way I found was to SIGKILL the process since process.exit() and app.exit() didn't work
      process.kill(process.pid, "SIGKILL");
    }
  });

  // Clean up PTT on quit
  app.on("before-quit", () => {
    cleanupPushToTalk();
    cleanupVirtualMic();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();

      mainWindow.webContents.openDevTools();

      mainWindow.webContents.on("did-start-loading", () => {
        console.log("[Window] did-start-loading");
      });

      mainWindow.webContents.on("did-stop-loading", () => {
        console.log("[Window] did-stop-loading");
      });

      mainWindow.webContents.on("did-finish-load", () => {
        console.log("[Window] did-finish-load:", mainWindow.webContents.getURL());
      });

      mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
        console.error("[Window] did-fail-load:", {
          errorCode,
          errorDescription,
          validatedURL,
        });
      });

      mainWindow.webContents.on("render-process-gone", (_event, details) => {
        console.error("[Window] render-process-gone:", details);
      });

      mainWindow.webContents.on("console-message", (_event, details) => {
        console.log(
          `[Renderer] ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`,
        );
      });

      if (config.pushToTalk) {
        registerPushToTalkHotkey().catch((error) => {
          console.error(
            "Failed to restore PTT after window recreation:",
            error,
          );
        });
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // Allow navigation to Stoat/Revolt API and CDN domains
    const allowedOrigins = [
      "https://stoat.chat",
      "https://beta.revolt.chat",
      "https://revolt.chat",
      "https://api.revolt.chat",
      "https://cdn.stoatusercontent.com",
      "https://autumn.stoatusercontent.com",
      "https://cdn.revolt.chat",
    ];

    // prevent navigation out of build URL origin (but allow API/CDN)
    contents.on("will-navigate", (event, navigationUrl) => {
      const url = new URL(navigationUrl);

      // Allow stoat:// protocol (local electron-serve)
      if (url.protocol === "stoat:") {
        return;
      }

      // Allow same origin (for local dev)
      if (url.origin === BUILD_URL.origin) {
        return;
      }

      // Allow known API/CDN origins
      if (
        allowedOrigins.some(
          (origin) => url.origin === origin || url.href.startsWith(origin),
        )
      ) {
        return;
      }

      // Block everything else
      console.log("[Window] Blocking navigation to:", navigationUrl);
      event.preventDefault();
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });
} else {
  app.quit();
}
