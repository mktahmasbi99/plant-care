import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Plus, X } from "lucide-react";
import { api, type PlantDetail } from "../api";

type Note = { id: number; body: string; care_date: string };
type View = { kind: "list" } | { kind: "read" | "edit"; id: number } | { kind: "new" };
function notesForPlant(plant: PlantDetail): Note[] {
  return plant.timeline
    .filter(event => event.type === "journal")
    .map(event => ({
      id: event.id,
      body: String(event.body),
      care_date: String(event.care_date || event.created_at).slice(0, 10),
    }));
}
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function NotePreview({ note, onOpen }: { note: Note; onOpen: () => void }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const measure = () => {
      if (text.current) setTruncated(text.current.scrollHeight > text.current.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    if (text.current) observer.observe(text.current);
    measure();
    return () => observer.disconnect();
  }, [note.body]);
  return <button className="notebook-note" onClick={onOpen}>
    <time dateTime={note.care_date}>{dateLabel(note.care_date)}</time>
    <p ref={text}>{note.body}</p>
    {truncated && <span className="notebook-more">See more</span>}
  </button>;
}

export function Notebook({ plant, onClose, onSaved }: { plant: PlantDetail; onClose: () => void; onSaved: () => void }) {
  const [notes, setNotes] = useState(() => notesForPlant(plant));
  const [view, setView] = useState<View>({ kind: "list" });
  const [body, setBody] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [today, setToday] = useState("");
  const pane = useRef<HTMLElement>(null);
  const guard = useRef<() => boolean>(() => true);
  const bypass = useRef(false);
  const [session] = useState(() => `${Date.now()}-${Math.random()}`);
  const closeRef = useRef(onClose);
  const restore = useRef<(next: View) => void>(setView);
  const note = "id" in view ? notes.find(note => note.id === view.id) : undefined;
  const editing = view.kind === "edit" || view.kind === "new";
  const dirty = editing && (body !== (note?.body || "") || (view.kind === "new" && date !== today));

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    restore.current = (next) => {
      if (next.kind === "edit" || next.kind === "new") {
        const entry = next.kind === "edit" ? notes.find(note => note.id === next.id) : undefined;
        setBody(entry?.body || "");
        setDate(entry?.care_date || today);
      }
      setView(next);
    };
  }, [notes, today]);
  useEffect(() => {
    guard.current = () => !saving && (!dirty || confirm("Discard your unsaved note changes?"));
  }, [dirty, saving]);
  useEffect(() => {
    let active = true;
    api.dashboard().then(result => { if (active) setToday(result.server_date); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Could not load today's date."); });
    const focused = document.activeElement as HTMLElement | null;
    pane.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const scroll = window.scrollY;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    if (history.state?.notebook !== session) {
      history.pushState({ notebook: session, view: { kind: "list" } }, "");
    }
    let restoring = false;
    const pop = (event: PopStateEvent) => {
      if (restoring) { restoring = false; return; }
      if (!bypass.current && !guard.current()) {
        restoring = true;
        history.forward();
        return;
      }
      bypass.current = false;
      setError("");
      if (event.state?.notebook === session) restore.current(event.state.view as View);
      else closeRef.current();
    };
    window.addEventListener("popstate", pop);
    return () => {
      active = false;
      window.removeEventListener("popstate", pop);
      document.body.style.overflow = overflow;
      history.scrollRestoration = previousRestoration;
      window.scrollTo(0, scroll);
      focused?.focus({ preventScroll: true });
    };
  }, [session]);
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);
  const open = (next: View) => {
    setError("");
    history.pushState({ notebook: session, view: next }, "");
    restore.current(next);
  };
  const back = (discard = false) => {
    if (saving) return;
    bypass.current = discard;
    history.back();
  };
  const save = async () => {
    if (saving || !date) return;
    setSaving(true);
    setError("");
    try {
      if (body.trim()) {
        if (note) await api.updateJournal(note.id, { care_date: note.care_date, body });
        else await api.journal(plant.id, { care_date: date, body }, false);
      } else if (note) await api.deleteJournal(note.id);
      const updated = await api.plant(plant.id);
      setNotes(notesForPlant(updated));
      onSaved();
      bypass.current = true;
      // A deleted note has no reader to return to.
      if (note && !body.trim()) history.go(-2);
      else history.back();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save this note.");
    } finally { setSaving(false); }
  };
  return <section ref={pane} className="notebook-page" role="dialog" aria-modal="true" aria-label={`${plant.display_name} Notebook`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); back(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)')).filter(element => element.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      } }}>
    <header className="note-editor-header">
      <button aria-label="Back" disabled={saving} onClick={() => back()}><ArrowLeft /></button>
      <div><strong>{plant.display_name}</strong><h2>Notebook</h2></div>
      {editing ? <div className="notebook-editor-actions">
        <button aria-label="Discard changes" disabled={saving} onClick={() => back(true)}><X /></button>
        <button className="note-editor-save" aria-label="Save" disabled={saving || !date} onClick={() => void save()}><Check /></button>
      </div> : view.kind === "read" ? <button disabled={!note} onClick={() => { if (note) open({ kind: "edit", id: note.id }); }}>Edit</button> : <button aria-label="Add note" disabled={!today} onClick={() => open({ kind: "new" })}><Plus /></button>}
    </header>
    {error && <p className="note-editor-error" role="alert">{error}</p>}
    <div className="notebook-list" hidden={view.kind !== "list"}>
      {notes.length ? [...notes].sort((a, b) => b.care_date.localeCompare(a.care_date) || b.id - a.id).map(note => <NotePreview key={note.id} note={note} onOpen={() => open({ kind: "read", id: note.id })} />) : <p className="muted">No notes yet. Tap ＋ to add one.</p>}
    </div>
    {view.kind !== "list" && <div className="note-editor-content notebook-content">
      {view.kind === "new" ? <label>Note date<input aria-label="Note date" type="date" value={date} max={today} disabled={saving} onChange={event => setDate(event.target.value)} /></label> : note && <time dateTime={note.care_date}>{dateLabel(note.care_date)}</time>}
      {editing ? <><textarea autoFocus aria-label="Note" maxLength={20000} value={body} disabled={saving} onChange={event => setBody(event.target.value)} placeholder="Write a note…" /><span className="note-editor-footer">{body.length.toLocaleString()} / 20,000</span></> : <p className="notebook-body">{note?.body || "This note has been deleted."}</p>}
    </div>}
  </section>;
}
