import { invoke } from '@tauri-apps/api/core';

export interface EnvironmentInfo {
  os: string;
  homeDir: string;
  documentsDir: string;
  desktopDir: string;
  downloadsDir: string;
  projectRoot: string;
}

interface RawEnvironmentInfo {
  os: string;
  home_dir: string;
  documents_dir: string;
  desktop_dir: string;
  downloads_dir: string;
  project_root: string;
}

export async function getEnvironmentInfo(): Promise<EnvironmentInfo> {
  const raw = await invoke<RawEnvironmentInfo>('get_environment_info');
  return {
    os: raw.os,
    homeDir: raw.home_dir,
    documentsDir: raw.documents_dir,
    desktopDir: raw.desktop_dir,
    downloadsDir: raw.downloads_dir,
    projectRoot: raw.project_root,
  };
}

export function formatEnvironmentContext(info: EnvironmentInfo): string {
  const projectLine = info.projectRoot
    ? `- Project root (the source tree for this very app — use this as the base when the user refers to "the project," "the repo," or its own code/docs, e.g. its Kanban board is at ${info.projectRoot}\\docs\\Kanban.md): ${info.projectRoot}\n`
    : '';
  return (
    `You are running on ${info.os}. Real filesystem paths for this user:\n` +
    `- Home: ${info.homeDir}\n` +
    `- Documents: ${info.documentsDir}\n` +
    `- Desktop: ${info.desktopDir}\n` +
    `- Downloads: ${info.downloadsDir}\n` +
    projectLine +
    `Use these exact paths (or a path the user explicitly gives you) for file operations — do not guess or invent a path.`
  );
}
