export type Status = 'never_watered' | 'on_track' | 'due_soon' | 'due' | 'overdue'

export type Recommendation = { id: number; interval_days: number; label: string; effective_from: string }
export type Plant = {
  id: number; species: string; nickname: string; display_name: string; location: string; care_note: string
  archived_at: string | null; created_at: string; recommendation: Recommendation; last_watered: string | null
  last_check: { id: number; date: string; outcome: 'watered' | 'not_watered' } | null
  status: { status: Status; next_check_date: string | null; days_since: number | null; days_until_check: number | null }
  cover_photo_id: number | null; sort_position: number
}
export type Dashboard = { server_date: string; due_count: number; plants: Plant[] }
export type TimelineEvent = Record<string, unknown> & { id: number; type: string; care_date?: string; created_at: string }
export type PlantDetail = Plant & { timeline: TimelineEvent[]; recommendation_history: Record<string, unknown>[] }
export type Fertilizer = { id: number; name: string; description: string; archived_at: string | null }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }, ...init })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string }
    throw new Error(body.detail || 'Something went wrong.')
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  dashboard: () => request<Dashboard>('/api/dashboard'),
  plants: (archived = false) => request<Plant[]>(`/api/plants${archived ? '?include_archived=true' : ''}`),
  plant: (id: number) => request<PlantDetail>(`/api/plants/${id}`),
  createPlant: (data: unknown) => request<Plant>('/api/plants', { method: 'POST', body: JSON.stringify(data) }),
  updatePlant: (id: number, data: unknown) => request<Plant>(`/api/plants/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  recommendation: (id: number, data: unknown) => request<Plant>(`/api/plants/${id}/recommendation`, { method: 'PUT', body: JSON.stringify(data) }),
  archive: (id: number) => request(`/api/plants/${id}/archive`, { method: 'POST' }),
  restorePlant: (id: number) => request(`/api/plants/${id}/restore`, { method: 'POST' }),
  deletePlant: (id: number) => request(`/api/plants/${id}?confirmation=DELETE`, { method: 'DELETE' }),
  adHocCheck: (plant: number, data: unknown) => request(`/api/plants/${plant}/checks`, { method: 'POST', body: JSON.stringify(data) }),
  reorderPlants: (plantIds: number[]) => request<{ plant_ids: number[] }>('/api/plants/order', { method: 'PUT', body: JSON.stringify({ plant_ids: plantIds }) }),
  deleteCheck: (check: number) => request(`/api/checks/${check}`, { method: 'DELETE' }),
  watering: (plant: number, data: unknown) => request(`/api/plants/${plant}/waterings`, { method: 'POST', body: JSON.stringify(data) }),
  journal: (plant: number, data: unknown) => request(`/api/plants/${plant}/journal`, { method: 'POST', body: JSON.stringify(data) }),
  fertilizers: () => request<Fertilizer[]>('/api/fertilizers'),
  createFertilizer: (data: unknown) => request<Fertilizer>('/api/fertilizers', { method: 'POST', body: JSON.stringify(data) }),
  fertilizerEvent: (plant: number, data: unknown) => request(`/api/plants/${plant}/fertilizer-events`, { method: 'POST', body: JSON.stringify(data) }),
  async uploadPhoto(plant: number, file: File, caption = '', journalId?: number) {
    const form = new FormData(); form.append('file', file); form.append('caption', caption)
    if (journalId) form.append('journal_entry_id', String(journalId))
    const response = await fetch(`/api/plants/${plant}/photos`, { method: 'POST', body: form })
    if (!response.ok) throw new Error((await response.json().catch(() => ({ detail: 'Upload failed.' }))).detail)
    return response.json() as Promise<{ id: number }>
  },
  setCover: (photo: number) => request(`/api/photos/${photo}/cover`, { method: 'POST' }),
  async restore(file: File) {
    const form = new FormData(); form.append('file', file); form.append('confirmation', 'RESTORE')
    const response = await fetch('/api/backups/restore-upload', { method: 'POST', body: form })
    if (!response.ok) throw new Error((await response.json().catch(() => ({ detail: 'Restore failed.' }))).detail)
    return response.json()
  },
}
