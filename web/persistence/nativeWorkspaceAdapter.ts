export function isTauriApp(windowRef: any = window): boolean {
  return Boolean(windowRef.__TAURI__ && windowRef.__TAURI__.core && windowRef.__TAURI__.dialog);
}

export async function pickNativeDirectory(windowRef: any = window): Promise<string | null> {
  const selected = await windowRef.__TAURI__.dialog.open({
    directory: true,
    recursive: true,
    multiple: false,
    canCreateDirectories: true
  });
  return Array.isArray(selected) ? selected[0] : selected;
}

export async function invokeNative(command: string, args = {}, windowRef: any = window) {
  return windowRef.__TAURI__.core.invoke(command, args);
}
