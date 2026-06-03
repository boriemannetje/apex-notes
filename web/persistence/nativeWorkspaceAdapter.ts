export interface NativeDirectoryPickerOptions {
  directory: boolean;
  recursive: boolean;
  multiple: boolean;
  canCreateDirectories: boolean;
}

export interface TauriDialogApi {
  open(options: NativeDirectoryPickerOptions): Promise<string | string[] | null>;
}

export interface TauriCoreApi {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface TauriWindow {
  __TAURI__?: {
    core?: TauriCoreApi;
    dialog?: TauriDialogApi;
  };
}

type BrowserTauriWindow = Window & TauriWindow;

export function isTauriApp(windowRef: TauriWindow = window as BrowserTauriWindow): boolean {
  return Boolean(windowRef.__TAURI__ && windowRef.__TAURI__.core && windowRef.__TAURI__.dialog);
}

export async function pickNativeDirectory(windowRef: TauriWindow = window as BrowserTauriWindow): Promise<string | null> {
  const selected = await windowRef.__TAURI__.dialog.open({
    directory: true,
    recursive: true,
    multiple: false,
    canCreateDirectories: true
  });
  return Array.isArray(selected) ? selected[0] || null : selected;
}

export async function invokeNative<T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
  windowRef: TauriWindow = window as BrowserTauriWindow
): Promise<T> {
  return windowRef.__TAURI__.core.invoke(command, args);
}
