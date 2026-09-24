export type SignalLevel = "neutral" | "amber" | "strong_amber" | "snoozed";
export type Plant = {
  id: number;
  species: string;
  nickname: string;
  display_name: string;
  location: string;
  care_note: string;
  archived_at: string | null;
  created_at: string;
  last_watered: string | null;
  last_check: {
    id: number;
    date: string;
    outcome: "watered" | "not_watered";
  } | null;
  watering_signal: {
    level: SignalLevel;
    days_since: number | null;
    estimated_interval_days: number | null;
    interval_count: number;
    snoozed_until: string | null;
  };
  cover_photo_id: number | null;
  sort_position: number;
};
export type Dashboard = {
  server_date: string;
  plants: Plant[];
};
export type TimelineEvent = Record<string, unknown> & {
  id: number;
  type: string;
  care_date?: string;
  created_at: string;
};
export type PlantDetail = Plant & {
  timeline: TimelineEvent[];
};
export type Fertilizer = {
  id: number;
  name: string;
  description: string;
  archived_at: string | null;
};
export type BackupCategory = "daily" | "weekly" | "on-demand" | "pre-import" | "pre-restore" | "pre-delete";
export type BackupFile = { filename: string; category: BackupCategory; createdAt: string; size: number; safety: boolean };
export type BackupSettings = {
  dailyEnabled: boolean; dailyTime: string; dailyRetention: number;
  weeklyEnabled: boolean; weeklyDay: number; weeklyTime: string;
  weeklyRetention: number; safetyRetention: number;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ detail: response.statusText }))) as { detail?: string };
    throw new Error(body.detail || "Something went wrong.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  dashboard: () => request<Dashboard>("/api/dashboard"),
  plants: (archived = false) =>
    request<Plant[]>(`/api/plants${archived ? "?include_archived=true" : ""}`),
  plant: (id: number) => request<PlantDetail>(`/api/plants/${id}`),
  createPlant: (data: unknown) =>
    request<Plant>("/api/plants", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updatePlant: (id: number, data: unknown) =>
    request<Plant>(`/api/plants/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  snooze: (id: number, untilDate: string) =>
    request<Plant>(`/api/plants/${id}/snooze`, {
      method: "PUT",
      body: JSON.stringify({ until_date: untilDate }),
    }),
  archive: (id: number) =>
    request(`/api/plants/${id}/archive`, { method: "POST" }),
  restorePlant: (id: number) =>
    request(`/api/plants/${id}/restore`, { method: "POST" }),
  deletePlant: (id: number) =>
    request(`/api/plants/${id}?confirmation=DELETE`, { method: "DELETE" }),
  adHocCheck: (plant: number, data: unknown) =>
    request(`/api/plants/${plant}/checks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  reorderPlants: (plantIds: number[]) =>
    request<{ plant_ids: number[] }>("/api/plants/order", {
      method: "PUT",
      body: JSON.stringify({ plant_ids: plantIds }),
    }),
  deleteCheck: (check: number) =>
    request(`/api/checks/${check}`, { method: "DELETE" }),
  watering: (plant: number, data: unknown) =>
    request(`/api/plants/${plant}/waterings`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateWatering: (watering: number, data: unknown) =>
    request(`/api/waterings/${watering}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteWatering: (watering: number) =>
    request(`/api/waterings/${watering}`, { method: "DELETE" }),
  journal: (plant: number, data: unknown) =>
    request(`/api/plants/${plant}/journal`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  fertilizers: () => request<Fertilizer[]>("/api/fertilizers"),
  createFertilizer: (data: unknown) =>
    request<Fertilizer>("/api/fertilizers", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  fertilizerEvent: (plant: number, data: unknown) =>
    request(`/api/plants/${plant}/fertilizer-events`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  async uploadPhoto(
    plant: number,
    file: File,
    caption = "",
    journalId?: number,
  ) {
    const form = new FormData();
    form.append("file", file);
    form.append("caption", caption);
    if (journalId) form.append("journal_entry_id", String(journalId));
    const response = await fetch(`/api/plants/${plant}/photos`, {
      method: "POST",
      body: form,
    });
    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => ({ detail: "Upload failed." })))
          .detail,
      );
    return response.json() as Promise<{ id: number }>;
  },
  setCover: (photo: number) =>
    request(`/api/photos/${photo}/cover`, { method: "POST" }),
  backups: () => request<BackupFile[]>("/api/backups"),
  backupSettings: () => request<BackupSettings>("/api/backups/settings"),
  saveBackupSettings: (data: BackupSettings) => request<BackupSettings>("/api/backups/settings", {
    method: "PUT", body: JSON.stringify(data),
  }),
  async createBackup() {
    const response = await fetch("/api/backups", { method: "POST" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({ detail: "Backup failed." }))).detail);
    return { blob: await response.blob(), filename: response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] || "plant-care-backup.sqlite3" };
  },
  async downloadBackup(filename: string) {
    const response = await fetch(`/api/backups/${encodeURIComponent(filename)}/download`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({ detail: "Download failed." }))).detail);
    return { blob: await response.blob(), filename };
  },
  restoreSavedBackup: (filename: string, confirmation: string) => request<{ backup: string }>("/api/backups/restore", {
    method: "POST", body: JSON.stringify({ filename, confirmation }),
  }),
  deleteBackup: (filename: string, confirmation: string) => request(`/api/backups/${encodeURIComponent(filename)}?confirmation=${encodeURIComponent(confirmation)}`, { method: "DELETE" }),
  async restore(file: File, confirmation: string) {
    const form = new FormData();
    form.append("file", file);
    form.append("confirmation", confirmation);
    const response = await fetch("/api/backups/restore-upload", {
      method: "POST",
      body: form,
    });
    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => ({ detail: "Restore failed." })))
          .detail,
      );
    return response.json();
  },
  async importLegacy(file: File, confirmation: string) {
    const form = new FormData(); form.append("file", file); form.append("confirmation", confirmation);
    const response = await fetch("/api/backups/import", { method: "POST", body: form });
    if (!response.ok) throw new Error((await response.json().catch(() => ({ detail: "Import failed." }))).detail);
    return response.json() as Promise<{ backup: string }>;
  },
};
