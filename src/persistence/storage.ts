/**
 * Browser storage for saves and settings: a primary slot, a backup of the
 * last good save for recovery, and export/import as a JSON file.
 */
import { parseSave, type SaveData } from '../sim/save';

const KEY = 'kinling.save.v1';
const BACKUP = 'kinling.save.backup';
const SETTINGS = 'kinling.settings.v1';

export interface Settings {
  volume: number;
  muted: boolean;
  reducedMotion: boolean;
  quality: 'auto' | 'low' | 'medium' | 'high';
  hintsSeen: string[];
}

export const DEFAULT_SETTINGS: Settings = { volume: 0.7, muted: false, reducedMotion: false, quality: 'auto', hintsSeen: [] };

function store(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function writeSave(data: SaveData): boolean {
  const s = store();
  if (!s) return false;
  try {
    const prev = s.getItem(KEY);
    if (prev && parseSave(prev)) s.setItem(BACKUP, prev);
    s.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Load the save, falling back to the backup if the primary slot is damaged. */
export function readSave(): { data: SaveData | null; recovered: boolean; damaged: boolean } {
  const s = store();
  if (!s) return { data: null, recovered: false, damaged: false };
  const main = s.getItem(KEY);
  const parsed = main ? parseSave(main) : null;
  if (parsed) return { data: parsed, recovered: false, damaged: false };
  const backup = s.getItem(BACKUP);
  const fromBackup = backup ? parseSave(backup) : null;
  if (fromBackup) return { data: fromBackup, recovered: true, damaged: true };
  return { data: null, recovered: false, damaged: !!main };
}

export function clearSave(): void {
  const s = store();
  s?.removeItem(KEY);
  s?.removeItem(BACKUP);
}

export function readSettings(): Settings {
  const s = store();
  try {
    const raw = s?.getItem(SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const o = JSON.parse(raw) as Partial<Settings>;
    return {
      volume: typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : DEFAULT_SETTINGS.volume,
      muted: o.muted === true,
      reducedMotion: o.reducedMotion === true,
      quality: o.quality === 'low' || o.quality === 'medium' || o.quality === 'high' ? o.quality : 'auto',
      hintsSeen: Array.isArray(o.hintsSeen) ? o.hintsSeen.filter((h) => typeof h === 'string').slice(0, 40) : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: Settings): void {
  try { store()?.setItem(SETTINGS, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
}

export function exportSave(data: SaveData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kinling-${(data.identity.name || 'save').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function importSave(file: File): Promise<SaveData | null> {
  if (file.size > 2_000_000) return null;
  return parseSave(await file.text());
}
