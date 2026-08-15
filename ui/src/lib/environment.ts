import { invoke } from '@tauri-apps/api/core';

export interface EnvironmentInfo {
  os: string;
  homeDir: string;
  documentsDir: string;
  desktopDir: string;
  downloadsDir: string;
}

interface RawEnvironmentInfo {
  os: string;
  home_dir: string;
  documents_dir: string;
  desktop_dir: string;
  downloads_dir: string;
}

export async function getEnvironmentInfo(): Promise<EnvironmentInfo> {
  const raw = await invoke<RawEnvironmentInfo>('get_environment_info');
  return {
    os: raw.os,
    homeDir: raw.home_dir,
    documentsDir: raw.documents_dir,
    desktopDir: raw.desktop_dir,
    downloadsDir: raw.downloads_dir,
  };
}

export function formatEnvironmentContext(info: EnvironmentInfo): string {
  return (
    `You are running on ${info.os}. Real filesystem paths for this user:\n` +
    `- Home: ${info.homeDir}\n` +
    `- Documents: ${info.documentsDir}\n` +
    `- Desktop: ${info.desktopDir}\n` +
    `- Downloads: ${info.downloadsDir}\n` +
    `Use these exact paths (or a path the user explicitly gives you) for file operations — do not guess or invent a path.`
  );
}
