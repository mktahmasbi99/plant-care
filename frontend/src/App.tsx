import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, BookOpen, Download, Droplets, Flower2, Leaf, Plus, Sprout, Upload, X } from 'lucide-react'
import { api, Dashboard, Fertilizer, Plant, PlantDetail, Status } from './api'

type Page = 'home' | 'plants' | 'detail' | 'fertilizer' | 'settings' | 'add'

const statusText: Record<Status, string> = {
  never_watered: 'No watering recorded', on_track: 'On track', due_soon: 'Due soon', due: 'Due today', overdue: 'Beyond usual interval',
}

function relative(days: number | null) {
  if (days === null) return 'No date yet'
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

function Avatar({ plant, large = false }: { plant: Plant; large?: boolean }) {
  const initials = plant.display_name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase()
  const hue = (plant.id * 47) % 180 + 70
  return plant.cover_photo_id ? <img className={`avatar ${large ? 'large' : ''}`} src={`/api/photos/${plant.cover_photo_id}?thumbnail=true`} alt="" /> :
    <div className={`avatar placeholder ${large ? 'large' : ''}`} style={{ '--plant-hue': hue } as React.CSSProperties}><Leaf size={large ? 34 : 23} /><span>{initials}</span></div>
}

function PlantCard({ plant, onAction, onOpen }: { plant: Plant; onAction: (plant: Plant, outcome: 'watered' | 'not_watered') => void; onOpen: () => void }) {
  const checked = plant.round_check
  return <article className={`plant-card ${plant.status.status}`}>
    <button className="card-main" onClick={onOpen} aria-label={`Open ${plant.display_name}`}>
      <Avatar plant={plant} />
      <span className="card-copy"><span className="card-title">{plant.display_name}</span><span className="species">{plant.species}{plant.location ? ` · ${plant.location}` : ''}</span></span>
      <span className="status-pill">{statusText[plant.status.status]}</span>
    </button>
    <div className="water-summary"><span>Last watered</span><strong>{plant.last_watered || 'Never'}</strong><small>{relative(plant.status.days_since)}</small></div>
    <div className="card-footer"><span>{plant.recommendation.label}</span>{checked ? <strong className="checked">{checked.outcome === 'watered' ? 'Watered' : 'Checked — not watered'}</strong> : <div className="actions"><button className="secondary" onClick={() => onAction(plant, 'not_watered')}>Not watered</button><button className="water" onClick={() => onAction(plant, 'watered')}><Droplets size={16} /> Watered</button></div>}</div>
    {plant.checked_today_not_watered && !checked && <p className="checked-today">Checked today — not watered</p>}
  </article>
}

function PlantForm({ initial, onSave, onCancel }: { initial?: Plant; onSave: (data: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [species, setSpecies] = useState(initial?.species || '')
  const [nickname, setNickname] = useState(initial?.nickname || '')
  const [location, setLocation] = useState(initial?.location || '')
  const [careNote, setCareNote] = useState(initial?.care_note || '')
  const [kind, setKind] = useState(initial?.recommendation.kind || 'weekly')
  const [value, setValue] = useState(initial?.recommendation.value || 1)
  const [lastWatered, setLastWatered] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { await onSave({ species, nickname, location, care_note: careNote, recommendation: { kind, value }, initial_last_watered: lastWatered || null }) } finally { setSaving(false) } }
  return <form className="form-stack" onSubmit={submit}>
    <label>Species<input required value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="e.g. Monstera deliciosa" /></label>
    <label>Nickname <span className="optional">optional</span><input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Kitchen Monstera" /></label>
    <label>Location <span className="optional">optional</span><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Living room" /></label>
    <fieldset><legend>Recommended watering</legend><div className="cadence"><select value={kind} onChange={(e) => { const nextKind = e.target.value as typeof kind; setKind(nextKind); setValue(nextKind === 'daily' || nextKind === 'monthly' ? 1 : value) }}><option value="daily">Every day</option><option value="weekly">Times per week</option><option value="monthly">Once per month</option><option value="days">Every N days</option></select>{kind !== 'daily' && <input aria-label="Frequency value" type="number" min="1" max="31" value={value} onChange={(e) => setValue(Number(e.target.value))} />}</div></fieldset>
    {!initial && <label>Last watered <span className="optional">optional</span><input type="date" value={lastWatered} onChange={(e) => setLastWatered(e.target.value)} /></label>}
    <label>Care instructions <span className="optional">permanent note</span><textarea rows={5} value={careNote} onChange={(e) => setCareNote(e.target.value)} placeholder="Overall maintenance routine, placement, soil, sensitivities…" /></label>
    <div className="form-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="water" disabled={saving}>{saving ? 'Saving…' : initial ? 'Save changes' : 'Add plant'}</button></div>
  </form>
}

export function App() {
  const [page, setPage] = useState<Page>('home')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [plants, setPlants] = useState<Plant[]>([])
  const [detail, setDetail] = useState<PlantDetail | null>(null)
  const [fertilizers, setFertilizers] = useState<Fertilizer[]>([])
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(!navigator.onLine)
  const [snack, setSnack] = useState<{ text: string; checkId: number } | null>(null)

  const reload = useCallback(async () => {
    try { const [next, all, products] = await Promise.all([api.dashboard(), api.plants(), api.fertilizers()]); setDashboard(next); setPlants(all); setFertilizers(products); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'Could not load Plant Care.') }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => { const online = () => setOffline(false), offline = () => setOffline(true); addEventListener('online', online); addEventListener('offline', offline); return () => { removeEventListener('online', online); removeEventListener('offline', offline) } }, [])
  useEffect(() => { if (!snack) return; const timer = window.setTimeout(() => setSnack(null), 8000); return () => clearTimeout(timer) }, [snack])

  const openPlant = async (id: number) => { try { setDetail(await api.plant(id)); setPage('detail') } catch (e) { setError(e instanceof Error ? e.message : 'Could not open plant.') } }
  const action = async (plant: Plant, outcome: 'watered' | 'not_watered') => {
    if (offline) return
    try {
      const result = plant.in_round && dashboard?.round.status === 'open' && !plant.round_check
        ? await api.roundCheck(dashboard.round.id, plant.id, { outcome }) as { check: { id: number } }
        : await api.adHocCheck(plant.id, { outcome }) as { id: number }
      setSnack({ text: outcome === 'watered' ? `${plant.display_name} marked watered.` : `${plant.display_name} checked without watering.`, checkId: 'check' in result ? result.check.id : result.id })
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save that check.') }
  }
  const savePlant = async (data: Record<string, unknown>) => { try { await api.createPlant(data); await reload(); setPage('plants') } catch (e) { setError(e instanceof Error ? e.message : 'Could not add plant.') } }
  const updatePlant = async (data: Record<string, unknown>) => {
    if (!detail) return
    try {
      const plantData = { ...(data as Record<string, unknown>) }
      const recommendation = plantData.recommendation
      delete plantData.recommendation
      delete plantData.initial_last_watered
      await api.updatePlant(detail.id, plantData)
      if (recommendation && JSON.stringify(recommendation) !== JSON.stringify({ kind: detail.recommendation.kind, value: detail.recommendation.value })) await api.recommendation(detail.id, recommendation)
      await reload(); await openPlant(detail.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save plant.') }
  }

  const title = page === 'home' ? 'Today' : page === 'plants' ? 'Plants' : page === 'detail' ? detail?.display_name || 'Plant' : page === 'fertilizer' ? 'Fertilizer' : page === 'settings' ? 'Settings' : 'Add plant'
  const topPlants = useMemo(() => dashboard?.round.plants || [], [dashboard])
  return <main className="app-shell">
    <header><div><span className="eyebrow"><Sprout size={16} /> Plant Care</span><h1>{title}</h1></div>{page === 'home' && <button className="icon-button" aria-label="Add plant" onClick={() => setPage('add')}><Plus /></button>}</header>
    {offline && <div className="banner">You are offline. Care actions are disabled until the app reconnects.</div>}
    {error && <div className="banner error">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
    {page === 'home' && <section className="page">
      {dashboard ? <><section className="round-heading"><div><p className="eyebrow">{new Date(`${dashboard.round.scheduled_date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h2>Inspection round</h2><p>{dashboard.round.completed} of {dashboard.round.total} plants checked</p></div><div className="progress" style={{ '--progress': `${dashboard.round.total ? dashboard.round.completed / dashboard.round.total * 100 : 100}%` } as React.CSSProperties}><span>{dashboard.round.total - dashboard.round.completed}</span></div></section>
      <section className="card-list">{topPlants.length ? topPlants.map((plant) => <PlantCard key={plant.id} plant={plant} onAction={action} onOpen={() => void openPlant(plant.id)} />) : <Empty onAdd={() => setPage('add')} />}</section>
      {dashboard.attention.filter((plant) => !plant.in_round).length > 0 && <><h2 className="section-title">Needs attention</h2><section className="card-list">{dashboard.attention.filter((plant) => !plant.in_round).map((plant) => <PlantCard key={plant.id} plant={plant} onAction={action} onOpen={() => void openPlant(plant.id)} />)}</section></>}
      </> : <Loading />}</section>}
    {page === 'plants' && <section className="page"><button className="wide-add" onClick={() => setPage('add')}><Plus /> Add plant</button><section className="card-list compact">{plants.map((plant) => <PlantCard key={plant.id} plant={plant} onAction={action} onOpen={() => void openPlant(plant.id)} />)}</section></section>}
    {page === 'add' && <section className="page panel"><PlantForm onSave={savePlant} onCancel={() => setPage('plants')} /></section>}
    {page === 'detail' && detail && <PlantDetailView detail={detail} fertilizers={fertilizers} onBack={() => setPage('plants')} onRefresh={() => void openPlant(detail.id)} onUpdate={updatePlant} onAction={action} onArchive={async () => { if (confirm(`Archive ${detail.display_name}?`)) { await api.archive(detail.id); await reload(); setPage('plants') } }} />}
    {page === 'fertilizer' && <FertilizerView products={fertilizers} onChanged={() => void reload()} />}
    {page === 'settings' && <Settings onRestored={() => void reload()} />}
    {page !== 'add' && page !== 'detail' && <nav><button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}><Sprout />Today</button><button className={page === 'plants' ? 'active' : ''} onClick={() => setPage('plants')}><Leaf />Plants</button><button className={page === 'fertilizer' ? 'active' : ''} onClick={() => setPage('fertilizer')}><Flower2 />Fertilizer</button><button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><BookOpen />Settings</button></nav>}
    {snack && <div className="snack">{snack.text}<button onClick={async () => { await api.deleteCheck(snack.checkId); setSnack(null); await reload() }}>Undo</button></div>}
  </main>
}

function Empty({ onAdd }: { onAdd: () => void }) { return <div className="empty"><Sprout size={40} /><h2>Your routine starts here</h2><p>Add each individual plant with a species and a watering recommendation.</p><button className="water" onClick={onAdd}><Plus /> Add your first plant</button></div> }
function Loading() { return <div className="empty"><p>Loading your plants…</p></div> }

function PlantDetailView({ detail, fertilizers, onBack, onRefresh, onUpdate, onAction, onArchive }: { detail: PlantDetail; fertilizers: Fertilizer[]; onBack: () => void; onRefresh: () => void; onUpdate: (data: Record<string, unknown>) => Promise<void>; onAction: (plant: Plant, outcome: 'watered' | 'not_watered') => void; onArchive: () => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'journal' | 'photo' | 'fertilizer'>('view')
  const [body, setBody] = useState(''); const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [file, setFile] = useState<File | null>(null); const [product, setProduct] = useState(''); const [amount, setAmount] = useState(''); const [dilution, setDilution] = useState(''); const [method, setMethod] = useState(''); const [fertilizerNote, setFertilizerNote] = useState('')
  if (mode === 'edit') return <section className="page panel"><button className="back" onClick={() => setMode('view')}>‹ Back</button><PlantForm initial={detail} onSave={async (data) => { await onUpdate(data); setMode('view') }} onCancel={() => setMode('view')} /></section>
  const timeline = detail.timeline
  return <section className="page detail"><button className="back" onClick={onBack}>‹ All plants</button><div className="detail-hero"><Avatar plant={detail} large /><div><h2>{detail.display_name}</h2><p>{detail.species}{detail.location ? ` · ${detail.location}` : ''}</p><strong>Last watered: {detail.last_watered || 'Never'}</strong><small>{relative(detail.status.days_since)} · {detail.recommendation.label}</small></div></div><div className="detail-actions"><button className="secondary" onClick={() => onAction(detail, 'not_watered')}>Not watered</button><button className="water" onClick={() => onAction(detail, 'watered')}><Droplets size={16} /> Watered</button></div>
    <section className="care-note"><div><h3>Care instructions</h3><p>{detail.care_note || 'No permanent care note yet.'}</p></div><button className="secondary" onClick={() => setMode('edit')}>Edit</button></section>
    <div className="quick-tools"><button onClick={() => setMode('journal')}><BookOpen />Journal note</button><button onClick={() => setMode('photo')}><Upload />Add photo</button><button onClick={() => setMode('fertilizer')}><Flower2 />Fertilizer</button><button onClick={onArchive}><Archive />Archive</button></div>
    {mode === 'journal' && <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); await api.journal(detail.id, { care_date: date, body }); setBody(''); setMode('view'); onRefresh() }}><label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><textarea required value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changed?" /><button className="water">Save journal entry</button></form>}
    {mode === 'photo' && <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (file) { const photo = await api.uploadPhoto(detail.id, file); if (!detail.cover_photo_id) await api.setCover(photo.id); setMode('view'); onRefresh() } }}><input required type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} /><button className="water">Upload photo</button></form>}
    {mode === 'fertilizer' && <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (product) { await api.fertilizerEvent(detail.id, { product_id: Number(product), care_date: date, amount, dilution, method, note: fertilizerNote }); setMode('view'); onRefresh() } }}><label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><select required value={product} onChange={(e) => setProduct(e.target.value)}><option value="">Select product</option>{fertilizers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><div className="form-grid"><label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Optional" /></label><label>Dilution<input value={dilution} onChange={(e) => setDilution(e.target.value)} placeholder="Optional" /></label></div><label>Method<input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Optional" /></label><label>Note<textarea value={fertilizerNote} onChange={(e) => setFertilizerNote(e.target.value)} placeholder="Optional" /></label><button className="water">Record fertilizer</button></form>}
    <h3 className="section-title">History</h3><section className="timeline">{timeline.length ? timeline.map((event) => <div className="timeline-event" key={`${event.type}-${event.id}`}><span className="event-date">{String(event.care_date || event.created_at).slice(0, 10)}</span><div><strong>{event.type === 'check' ? event.outcome === 'watered' ? 'Watered during check' : 'Checked — not watered' : event.type === 'watering' ? 'Watered' : event.type === 'fertilizer' ? `Fertilized with ${event.product_name}` : event.type === 'journal' ? 'Journal note' : 'Photo added'}</strong>{typeof event.body === 'string' && <p>{event.body}</p>}{typeof event.note === 'string' && event.note && <p>{event.note}</p>}{event.type === 'photo' && <img src={`/api/photos/${event.id}?thumbnail=true`} alt="Plant history" />}</div></div>) : <p className="muted">No events yet.</p>}</section>
  </section>
}

function FertilizerView({ products, onChanged }: { products: Fertilizer[]; onChanged: () => void }) { const [name, setName] = useState(''); const [description, setDescription] = useState(''); return <section className="page"><form className="panel form-stack" onSubmit={async (e) => { e.preventDefault(); await api.createFertilizer({ name, description }); setName(''); setDescription(''); onChanged() }}><h2>Add fertilizer</h2><label>Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Liquid seaweed" /></label><label>Description <span className="optional">optional</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label><button className="water">Add product</button></form><h2 className="section-title">Your products</h2><div className="simple-list">{products.map((product) => <div key={product.id}><Flower2 /><span><strong>{product.name}</strong><small>{product.description}</small></span></div>)}{!products.length && <p className="muted">Add products here before recording their use for a plant.</p>}</div></section> }

function Settings({ onRestored }: { onRestored: () => void }) { const [file, setFile] = useState<File | null>(null); const [message, setMessage] = useState(''); return <section className="page"><section className="panel settings"><h2>Backup</h2><p>Download one self-contained SQLite backup. It includes plants, history, notes, fertilizer, and optimized photos.</p><a className="water link-button" href="/api/backups/download"><Download size={16} /> Download backup</a></section><form className="panel settings" onSubmit={async (e) => { e.preventDefault(); if (!file || !confirm('Restore this backup? The current database will first be snapshotted.')) return; try { await api.restore(file); setMessage('Backup restored successfully.'); onRestored() } catch (error) { setMessage(error instanceof Error ? error.message : 'Restore failed.') } }}><h2>Restore</h2><p>Restoring replaces current data after validation. A pre-restore snapshot is retained in the data folder.</p><input required type="file" accept=".sqlite,.sqlite3,application/x-sqlite3" onChange={(e) => setFile(e.target.files?.[0] || null)} /><button className="secondary"><Upload size={16} /> Restore backup</button>{message && <p className="muted">{message}</p>}</form><section className="panel settings"><h2>Private access</h2><p>Plant Care has no accounts. Keep it limited to your trusted LAN and Tailscale network; do not expose its port to the public internet.</p></section></section> }
