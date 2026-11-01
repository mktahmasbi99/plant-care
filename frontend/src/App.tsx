import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BookOpen,
  Camera,
  Download,
  Droplets,
  FileImage,
  Flower2,
  GripVertical,
  Images,
  Leaf,
  MoreVertical,
  NotebookPen,
  NotebookText,
  Pencil,
  Plus,
  Sprout,
  Upload,
  X,
} from "lucide-react";
import { api, BackupFile, BackupSettings, Dashboard, Fertilizer, Plant, PlantDetail, TimelineEvent } from "./api";
import { InstallAppPanel, type PwaInstallState } from "./components/InstallAppPanel";
import { usePwaInstall } from "./hooks/usePwaInstall";

type Page = "home" | "detail" | "fertilizer" | "settings" | "add";
function lastWateredLabel(plant: Plant) {
  const days = plant.watering_signal.days_since;
  if (!(plant.last_watered || plant.started_on) || days === null) return "Never";
  if (days < 0) return plant.last_watered;
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
function dateAfter(day: string, days: number) {
  const result = new Date(`${day}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
function CalendarDialog({
  selectedDate,
  maxDate,
  onSelect,
  onClose,
}: {
  selectedDate: string;
  maxDate: string;
  onSelect: (day: string) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(() => {
    const [year, monthNumber] = selectedDate.split("-").map(Number);
    return new Date(year, monthNumber - 1, 1);
  });
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const maxMonth = maxDate.slice(0, 7);
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(month);
  const days = Array.from({ length: firstWeekday + lastDay }, (_, index) =>
    index < firstWeekday ? null : index - firstWeekday + 1,
  );
  const formatDate = (day: number) =>
    `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return (
    <div
      className="calendar-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <section
        className="calendar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="calendar-dialog-header">
          <h2 id="calendar-title">Calendar</h2>
          <button className="icon-button" aria-label="Close calendar" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="calendar-month-row">
          <button
            type="button"
            className="calendar-month-arrow"
            aria-label="Previous month"
            onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}
          >
            ‹
          </button>
          <h3>{monthLabel}</h3>
          <button
            type="button"
            className="calendar-month-arrow"
            aria-label="Next month"
            disabled={monthKey >= maxMonth}
            onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}
          >
            ›
          </button>
        </div>
        <div className="calendar-grid calendar-weekdays" aria-hidden="true">
          {[
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ].map((weekday) => (
            <span key={weekday}>{weekday.slice(0, 3)}</span>
          ))}
        </div>
        <div className="calendar-grid calendar-days">
          {days.map((day, index) =>
            day === null ? (
              <span className="calendar-day-empty" key={`empty-${index}`} />
            ) : (
              <button
                type="button"
                key={day}
                className={[
                  "calendar-day",
                  formatDate(day) === selectedDate ? "selected" : "",
                  formatDate(day) === maxDate ? "today" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={new Date(year, monthIndex, day).toLocaleDateString()}
                aria-pressed={formatDate(day) === selectedDate}
                disabled={formatDate(day) > maxDate}
                onClick={() => onSelect(formatDate(day))}
              >
                {day}
              </button>
            ),
          )}
        </div>
        <button className="calendar-jump-today" onClick={() => onSelect(maxDate)}>
          Jump to today
        </button>
      </section>
    </div>
  );
}

function wateringEventDate(event: TimelineEvent) {
  return String(event.care_date || event.created_at).slice(0, 10);
}

function formatCareDate(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, date));
}

function WateringCalendar({
  events,
  selectedDate,
  onSelectDate,
}: {
  events: TimelineEvent[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const wateredDates = new Set(events.map(wateringEventDate));
  const today = new Date();
  const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const todayKey = `${currentMonthKey}-${String(today.getDate()).padStart(2, "0")}`;
  const latestWateredDate = [...wateredDates].sort().at(-1);
  const [month, setMonth] = useState(() => {
    const initial = latestWateredDate ? new Date(`${latestWateredDate}T12:00:00`) : today;
    return new Date(initial.getFullYear(), initial.getMonth(), 1);
  });
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(month);
  const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const days = Array.from({ length: firstWeekday + lastDay }, (_, index) =>
    index < firstWeekday ? null : index - firstWeekday + 1,
  );
  const formatDate = (day: number) =>
    `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return (
    <section className="watering-calendar" aria-label="Plant watering calendar">
      <div className="watering-calendar-month">
        <button
          type="button"
          className="calendar-month-arrow"
          aria-label="Previous month"
          onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}
        >
          ‹
        </button>
        <h4>{monthLabel}</h4>
        <button
          type="button"
          className="calendar-month-arrow"
          aria-label="Next month"
          disabled={monthKey >= currentMonthKey}
          onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}
        >
          ›
        </button>
      </div>
      <div className="watering-calendar-grid watering-calendar-weekdays" aria-hidden="true">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="watering-calendar-grid watering-calendar-days">
        {days.map((day, index) => {
          if (day === null)
            return <span className="watering-calendar-empty" key={`empty-${index}`} />;
          const date = formatDate(day);
          const watered = wateredDates.has(date);
          const isToday = date === todayKey;
          const label = new Date(year, monthIndex, day).toLocaleDateString();
          return (
            <button
              type="button"
              key={date}
              className={`watering-calendar-day${watered ? " watered" : ""}${isToday ? " today" : ""}${selectedDate === date ? " selected" : ""}`}
              aria-label={watered ? `${label}, watered` : label}
              aria-pressed={selectedDate === date}
              disabled={date > todayKey}
              onClick={() => onSelectDate(date)}
            >
              <span>{day}</span>
              {watered && <Droplets size={14} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {selectedDate !== todayKey && (
        <button
          type="button"
          className="calendar-jump-today watering-calendar-jump-today"
          onClick={() => {
            setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
            onSelectDate(todayKey);
          }}
        >
          Jump to today
        </button>
      )}
    </section>
  );
}

function signalText(plant: Plant) {
  const signal = plant.watering_signal;
  if (signal.level === "snoozed") return `Snoozed until ${signal.snoozed_until}`;
  if (signal.level === "strong_amber") return "Much longer than usual";
  if (signal.level === "amber") return "Around the usual interval";
  if (signal.estimated_interval_days === null) return "Learning from watering history";
  return "Before the usual interval";
}
function patternText(plant: Plant) {
  const signal = plant.watering_signal;
  if (signal.estimated_interval_days === null) return "No interval learned yet";
  const days = signal.estimated_interval_days;
  return `Usual interval: about ${days} day${days === 1 ? "" : "s"}${signal.interval_count === 1 ? " (tentative)" : ""}`;
}
function canSnooze(plant: Plant) {
  return ["amber", "strong_amber"].includes(plant.watering_signal.level);
}

function Avatar({ plant, large = false }: { plant: Plant; large?: boolean }) {
  const initials = plant.display_name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const hue = ((plant.id * 47) % 180) + 70;
  return plant.profile_photo_id ? (
    <img
      className={`avatar ${large ? "large" : ""}`}
      src={`/api/plants/${plant.id}/profile-photo?thumbnail=true`}
      alt=""
    />
  ) : (
    <div
      className={`avatar placeholder ${large ? "large" : ""}`}
      style={{ "--plant-hue": hue } as React.CSSProperties}
    >
      <Leaf size={large ? 34 : 23} />
      <span>{initials}</span>
    </div>
  );
}

function PlantCard({
  plant,
  position,
  activeDate,
  onWater,
  onUndo,
  onSnooze,
  onOpen,
  onOpenNote,
  onAddPhoto,
}: {
  plant: Plant;
  position: number;
  activeDate: string;
  onWater: (plant: Plant) => Promise<void>;
  onUndo: (plant: Plant, checkId: number) => Promise<void>;
  onSnooze: (plant: Plant) => void;
  onOpen: () => void;
  onOpenNote: (plant: Plant, date: string) => void;
  onAddPhoto: (plant: Plant, date: string, file: File) => Promise<void>;
}) {
  const sortable = useSortable({ id: plant.id });
  const photoInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [photoPending, setPhotoPending] = useState(false);
  const handleWater = async () => {
    setPending(true);
    try {
      if (plant.day_watered_check_id)
        await onUndo(plant, plant.day_watered_check_id);
      else await onWater(plant);
    } finally {
      setPending(false);
    }
  };
  return (
    <article
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`plant-card signal-${plant.watering_signal.level} ${sortable.isDragging ? "dragging" : ""}`}
    >
      <button
        className="drag-handle"
        aria-label={`Reorder ${plant.display_name}`}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical size={20} />
      </button>
      <div className="card-heading">
        <button
          className="card-main"
          onClick={onOpen}
          aria-label={`Open ${plant.display_name}`}
        >
          <Avatar plant={plant} />
          <span className="card-copy">
            <span className="card-title">
              <span className="card-position" aria-label={`Position ${position}`}>
                {String(position).padStart(2, "0")}
              </span>
              <span className="card-title-name">{plant.display_name}</span>
            </span>
            <span className="species">
              {plant.species}
              {plant.location ? ` · ${plant.location}` : ""}
            </span>
          </span>
        </button>
        <div className="card-day-actions">
          <input
            ref={photoInput}
            hidden
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            capture="environment"
            aria-label={`Choose a photo for ${plant.display_name} on ${activeDate}`}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setPhotoPending(true);
              try {
                await onAddPhoto(plant, activeDate, file);
              } finally {
                setPhotoPending(false);
                event.target.value = "";
              }
            }}
          />
          <button
            type="button"
            className={`day-action${plant.day_photo_count ? " active" : ""}`}
            aria-label={`Add photo for ${plant.display_name} on ${activeDate}${plant.day_photo_count ? `; ${plant.day_photo_count} saved` : ""}`}
            title={plant.day_photo_count ? `${plant.day_photo_count} photos saved` : "Add photo"}
            disabled={photoPending}
            onClick={() => photoInput.current?.click()}
          >
            <FileImage size={19} />
          </button>
          <button
            type="button"
            className={`day-action${plant.day_note_id ? " active" : ""}`}
            aria-label={`${plant.day_note_id ? "Edit" : "Add"} note for ${plant.display_name} on ${activeDate}`}
            aria-pressed={Boolean(plant.day_note_id)}
            title={plant.day_note_id ? "Edit this day’s note" : "Add a note"}
            onClick={() => onOpenNote(plant, activeDate)}
          >
            <NotebookText size={19} />
          </button>
        </div>
      </div>
      <div className="water-summary">
        <span>{!plant.last_watered && plant.started_on ? "Started on" : "Last watered"}</span>
        <strong>{lastWateredLabel(plant)}</strong>
        <span
          className={`signal-dot ${plant.watering_signal.level}`}
          role="img"
          aria-label={signalText(plant)}
        />
        <small>{plant.last_watered || plant.started_on || "No date recorded"}</small>
      </div>
      <div className="card-footer">
        <span>{signalText(plant)} · {patternText(plant)}</span>
        <div className="actions">
          {canSnooze(plant) && (
            <button className="secondary" onClick={() => onSnooze(plant)}>
              Snooze
            </button>
          )}
          <button className={plant.day_watered_check_id ? "secondary" : "water"} disabled={pending} onClick={() => void handleWater()}>
            <Droplets size={16} /> {plant.day_watered_check_id ? "Undo" : "Watered"}
          </button>
        </div>
      </div>
    </article>
  );
}

function DayNoteEditor({
  plant,
  date,
  onClose,
  onSaved,
}: {
  plant: Plant;
  date: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [entry, setEntry] = useState<{ id: number; body: string } | null>(null);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const initialBody = useRef("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.journalForDay(plant.id, date)
      .then((note) => {
        if (!active) return;
        setEntry(note);
        setBody(note?.body || "");
        initialBody.current = note?.body || "";
      })
      .catch((error) => setError(error instanceof Error ? error.message : "Could not load this note."))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [plant.id, date]);

  const close = () => {
    if (body !== initialBody.current && !confirm("Discard your unsaved note changes?")) return;
    onClose();
  };
  const save = async () => {
    if (!body.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await api.journal(plant.id, { care_date: date, body });
      await onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save this note.");
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!entry || !confirm(`Delete ${formatCareDate(date)}’s note?`)) return;
    setSaving(true);
    setError("");
    try {
      await api.deleteJournal(entry.id);
      await onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete this note.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="note-editor-backdrop" role="presentation" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") close(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="note-editor" role="dialog" aria-modal="true" aria-labelledby="note-editor-title">
        <header className="note-editor-header">
          <button type="button" className="note-editor-close" onClick={close}>Close</button>
          <button type="button" className="note-editor-save" disabled={loading || saving || !body.trim() || body === initialBody.current} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </header>
        <div className="note-editor-content">
          <h2 id="note-editor-title">{plant.display_name}</h2>
          <time dateTime={date}>{formatCareDate(date)}</time>
          <textarea
            autoFocus
            aria-label={`Note for ${plant.display_name} on ${date}`}
            maxLength={20000}
            value={body}
            disabled={loading || saving}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a note for this day…"
          />
          {error && <p role="alert" className="note-editor-error">{error}</p>}
          <div className="note-editor-footer">
            <span aria-live="polite">{body.length.toLocaleString()} / 20,000</span>
            {entry && <button type="button" className="delete-menu-item" disabled={saving} onClick={() => void remove()}>Delete note</button>}
          </div>
        </div>
      </section>
    </div>
  );
}

function PlantList({
  plants,
  activeDate,
  onWater,
  onUndo,
  onSnooze,
  onOpen,
  onOpenNote,
  onAddPhoto,
  onReorder,
}: {
  plants: Plant[];
  activeDate: string;
  onWater: (plant: Plant) => Promise<void>;
  onUndo: (plant: Plant, checkId: number) => Promise<void>;
  onSnooze: (plant: Plant) => void;
  onOpen: (id: number) => void;
  onOpenNote: (plant: Plant, date: string) => void;
  onAddPhoto: (plant: Plant, date: string, file: File) => Promise<void>;
  onReorder: (ids: number[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 450, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const from = plants.findIndex((plant) => plant.id === active.id);
      const to = plants.findIndex((plant) => plant.id === over.id);
      onReorder(arrayMove(plants, from, to).map((plant) => plant.id));
    }
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={plants.map((plant) => plant.id)}
        strategy={verticalListSortingStrategy}
      >
        <section className="card-list">
          {plants.map((plant, index) => (
            <PlantCard
              key={plant.id}
              plant={plant}
              position={index + 1}
              activeDate={activeDate}
              onWater={onWater}
              onUndo={onUndo}
              onSnooze={onSnooze}
              onOpen={() => onOpen(plant.id)}
              onOpenNote={onOpenNote}
              onAddPhoto={onAddPhoto}
            />
          ))}
        </section>
      </SortableContext>
    </DndContext>
  );
}

function PlantForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Plant;
  onSave: (data: Record<string, unknown>, photo: File | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [species, setSpecies] = useState(initial?.species || "");
  const [nickname, setNickname] = useState(initial?.nickname || "");
  const [location, setLocation] = useState(initial?.location || "");
  const [careNote, setCareNote] = useState(initial?.care_note || "");
  const [startedOn, setStartedOn] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const profilePhotoInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(
        {
          species,
          nickname,
          location,
          care_note: careNote,
          started_on: startedOn || null,
        },
        photo,
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        Species
        <input
          required
          value={species}
          onChange={(e) => setSpecies(e.target.value)}
        />
      </label>
      <label>
        Nickname <span className="optional">optional</span>
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} />
      </label>
      <label>
        Location <span className="optional">optional</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>
      {!initial && (
        <label>
          Started on <span className="optional">optional</span>
          <input
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            value={startedOn}
            onChange={(e) => setStartedOn(e.target.value)}
          />
        </label>
      )}
      <div className="profile-photo-field">
        <span>Profile photo <span className="optional">optional</span></span>
        <input
          ref={profilePhotoInput}
          className="visually-hidden"
          aria-label="Plant profile photo"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          capture="environment"
          onChange={(event) => setPhoto(event.target.files?.[0] || null)}
        />
        <button
          type="button"
          className="profile-photo-picker"
          aria-label="Choose profile photo"
          onClick={() => profilePhotoInput.current?.click()}
        >
          {initial?.profile_photo_id ? (
            <img src={`/api/plants/${initial.id}/profile-photo?thumbnail=true`} alt="Current profile photo" />
          ) : (
            <span className="profile-photo-placeholder"><Leaf size={28} /></span>
          )}
          <span className="profile-photo-camera" aria-hidden="true"><Camera size={16} /></span>
        </button>
        {photo && <small>{photo.name}</small>}
      </div>
      <label>
        Care instructions <span className="optional">permanent note</span>
        <textarea
          rows={5}
          value={careNote}
          onChange={(e) => setCareNote(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="water" disabled={saving}>
          {saving ? "Saving…" : initial ? "Save changes" : "Add plant"}
        </button>
      </div>
    </form>
  );
}

function SnoozeSheet({
  plant,
  serverDate,
  onChoose,
  onClose,
}: {
  plant: Plant;
  serverDate: string;
  onChoose: (date: string) => void;
  onClose: () => void;
}) {
  const tomorrow = dateAfter(serverDate, 1);
  const [days, setDays] = useState("7");
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="recheck-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snooze-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="snooze-title">Snooze {plant.display_name}</h2>
        <p>
          The signal will return on the day you choose. Last watered time stays
          visible.
        </p>
        <div className="recheck-options">
          <button
            className="secondary"
            autoFocus
            onClick={() => onChoose(tomorrow)}
          >
            Tomorrow
          </button>
          <button
            className="water"
            onClick={() => onChoose(dateAfter(serverDate, 2))}
          >
            In 2 days
          </button>
          <button
            className="secondary"
            onClick={() => onChoose(dateAfter(serverDate, 3))}
          >
            In 3 days
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onChoose(dateAfter(serverDate, Number(days)));
          }}
        >
          <label>
            Snooze for
            <input
              aria-label="Days to snooze"
              required
              min="1"
              max="365"
              type="number"
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            days
          </label>
          <button className="secondary">Snooze until then</button>
        </form>
        <button className="sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </section>
    </div>
  );
}

function DeletePlantDialog({
  plant,
  onDelete,
  onClose,
}: {
  plant: Plant;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (confirmation !== "DELETE") return;
    setDeleting(true);
    try {
      await onDelete();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not delete this plant.",
      );
      setDeleting(false);
    }
  };
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="recheck-sheet delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="delete-title">Delete {plant.display_name}?</h2>
        <p>
          This permanently removes the plant and all of its history. This cannot
          be undone.
        </p>
        <label>
          Type DELETE to confirm
          <input
            aria-label="Type DELETE to confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
          />
        </label>
        {error && <p className="delete-error">{error}</p>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            className="danger"
            disabled={confirmation !== "DELETE" || deleting}
          >
            {deleting ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [detail, setDetail] = useState<PlantDetail | null>(null);
  const [fertilizers, setFertilizers] = useState<Fertilizer[]>([]);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [noteTarget, setNoteTarget] = useState<{ plant: Plant; date: string } | null>(null);
  const pwaInstall = usePwaInstall();
  const [snoozePlant, setSnoozePlant] = useState<Plant | null>(null);
  const [dashboardDate, setDashboardDate] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const viewedDate = useRef<string | undefined>(undefined);
  const actualToday = useRef<string | undefined>(undefined);
  const reload = useCallback(async () => {
    try {
      const [next, products] = await Promise.all([
        api.dashboard(viewedDate.current),
        api.fertilizers(),
      ]);
      if (!actualToday.current) actualToday.current = next.server_date;
      viewedDate.current = next.server_date;
      setDashboardDate(next.server_date);
      setDashboard(next);
      setFertilizers(products);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Plant Care.");
    }
  }, []);
  const loadDashboardDate = async (day: string) => {
    if (actualToday.current && day > actualToday.current) return;
    try {
      const next = await api.dashboard(day);
      viewedDate.current = next.server_date;
      setDashboardDate(next.server_date);
      setDashboard(next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this date.");
    }
  };
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const online = () => setOffline(false),
      offline = () => setOffline(true);
    addEventListener("online", online);
    addEventListener("offline", offline);
    return () => {
      removeEventListener("online", online);
      removeEventListener("offline", offline);
    };
  }, []);
  const openPlant = async (id: number) => {
    try {
      setDetail(await api.plant(id));
      setPage("detail");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open plant.");
    }
  };
  const saveWatering = async (plant: Plant) => {
    if (offline) return;
    try {
      await api.adHocCheck(plant.id, {
        outcome: "watered",
        care_date: dashboardDate || undefined,
      });
      await reload();
      if (detail?.id === plant.id) await openPlant(plant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record watering.");
    }
  };
  const undoWatering = async (plant: Plant, checkId: number) => {
    if (offline) return;
    try {
      await api.deleteCheck(checkId);
      await reload();
      if (detail?.id === plant.id) await openPlant(plant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not undo watering.");
    }
  };
  const addDayPhoto = async (plant: Plant, date: string, file: File) => {
    if (offline) return;
    try {
      await api.uploadPhoto(plant.id, file, date);
      await reload();
      if (detail?.id === plant.id) await openPlant(plant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add this photo.");
    }
  };
  const saveSnooze = async (plant: Plant, untilDate: string) => {
    if (offline) return;
    try {
      await api.snooze(plant.id, untilDate);
      setSnoozePlant(null);
      await reload();
      if (detail?.id === plant.id) await openPlant(plant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not snooze this plant.");
    }
  };
  const reorder = async (ids: number[]) => {
    const oldDashboard = dashboard;
    const arrange = (items: Plant[]) =>
      ids
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is Plant => Boolean(item));
    setDashboard((current) =>
      current ? { ...current, plants: arrange(current.plants) } : current,
    );
    try {
      await api.reorderPlants(ids);
    } catch (e) {
      setDashboard(oldDashboard);
      setError(e instanceof Error ? e.message : "Could not save card order.");
    }
  };
  const savePlant = async (
    data: Record<string, unknown>,
    photo: File | null,
  ) => {
    try {
      const plant = await api.createPlant(data);
      if (photo) await api.uploadProfilePhoto(plant.id, photo);
      await reload();
      setPage("home");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add plant.");
    }
  };
  const returnToToday = async () => {
    setDetail(null);
    setPage("home");
    if (actualToday.current) await loadDashboardDate(actualToday.current);
    else await reload();
  };
  const updatePlant = async (data: Record<string, unknown>, photo: File | null) => {
    if (!detail) return;
    try {
      const plantData = { ...data };
      delete plantData.initial_last_watered;
      await api.updatePlant(detail.id, plantData);
      if (photo) await api.uploadProfilePhoto(detail.id, photo);
      await reload();
      await openPlant(detail.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save plant.");
    }
  };
  const title =
    page === "home"
      ? "Today"
      : page === "detail"
        ? detail?.display_name || "Plant"
        : page === "fertilizer"
          ? "Fertilizer"
          : page === "settings"
            ? "Settings"
            : "Add plant";
  const serverDate = dashboardDate || dashboard?.server_date || new Date().toISOString().slice(0, 10);
  const dateTitle =
    serverDate === actualToday.current
      ? "Today"
      : actualToday.current && serverDate === dateAfter(actualToday.current, -1)
        ? "Yesterday"
      : new Date(`${serverDate}T12:00:00`).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
  return (
    <main className="app-shell">
      <header className={page === "home" ? "home-header" : undefined}>
        <div className="home-brand">
          <button
            type="button"
            className="eyebrow brand-link"
            aria-label="Go to Today"
            onClick={() => void returnToToday()}
          >
            <Sprout size={16} /> Plant Care
          </button>
          {page !== "home" && <h1>{title}</h1>}
        </div>
        {page === "home" && (
          <div className="home-date-control">
            <button
              type="button"
              className="date-step"
              aria-label="Previous day"
              onClick={() => void loadDashboardDate(dateAfter(serverDate, -1))}
            >
              ‹
            </button>
            <button
              type="button"
              className="date-title"
              aria-label={`Choose date, ${dateTitle}`}
              onClick={() => setCalendarOpen(true)}
            >
              <h1>{dateTitle}</h1>
            </button>
            {serverDate < (actualToday.current || serverDate) && (
              <button
                type="button"
                className="date-step"
                aria-label="Next day"
                onClick={() => void loadDashboardDate(dateAfter(serverDate, 1))}
              >
                ›
              </button>
            )}
          </div>
        )}
        {page === "home" && (
          <button
            className="icon-button"
            aria-label="Add plant"
            onClick={() => setPage("add")}
          >
            <Plus />
          </button>
        )}
      </header>
      {offline && (
        <div className="banner">
          You are offline. Care actions are disabled until the app reconnects.
        </div>
      )}
      {error && (
        <div className="banner error">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      {page === "home" && (
        <section className="page">
          {dashboard ? (
            <>
              {dashboard.plants.length ? (
                <PlantList
                  plants={dashboard.plants}
                  activeDate={serverDate}
                  onWater={saveWatering}
                  onUndo={undoWatering}
                  onSnooze={setSnoozePlant}
                  onOpen={(id) => void openPlant(id)}
                  onOpenNote={(plant, date) => setNoteTarget({ plant, date })}
                  onAddPhoto={addDayPhoto}
                  onReorder={(ids) => void reorder(ids)}
                />
              ) : (
                <Empty onAdd={() => setPage("add")} />
              )}
            </>
          ) : (
            <Loading />
          )}
        </section>
      )}
      {page === "add" && (
        <section className="page panel">
          <PlantForm onSave={savePlant} onCancel={() => setPage("home")} />
        </section>
      )}
      {page === "detail" && detail && (
        <PlantDetailView
          detail={detail}
          activeDate={serverDate}
          dayWateredCheckId={
            dashboard?.plants.find((plant) => plant.id === detail.id)?.day_watered_check_id ?? null
          }
          fertilizers={fertilizers}
          onBack={() => void returnToToday()}
          onRefresh={() => void openPlant(detail.id)}
          onUpdate={updatePlant}
          onWater={saveWatering}
          onUndo={undoWatering}
          onSnooze={setSnoozePlant}
          onArchive={async () => {
            if (confirm(`Archive ${detail.display_name}?`)) {
              await api.archive(detail.id);
              await reload();
              setPage("home");
            }
          }}
          onDelete={async () => {
            await api.deletePlant(detail.id);
            await reload();
            setDetail(null);
            setPage("home");
          }}
        />
      )}
      {page === "fertilizer" && (
        <FertilizerView
          products={fertilizers}
          onChanged={() => void reload()}
        />
      )}
      {page === "settings" && <Settings onRestored={() => void reload()} pwaInstall={pwaInstall} />}
      {page !== "add" && page !== "detail" && (
        <nav>
          <button
            className={page === "home" ? "active" : ""}
            onClick={() => setPage("home")}
          >
            <Sprout />
            Today
          </button>
          <button
            className={page === "fertilizer" ? "active" : ""}
            onClick={() => setPage("fertilizer")}
          >
            <Flower2 />
            Fertilizer
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            <BookOpen />
            Settings
          </button>
        </nav>
      )}
      {noteTarget && (
        <DayNoteEditor
          plant={noteTarget.plant}
          date={noteTarget.date}
          onClose={() => setNoteTarget(null)}
          onSaved={async () => {
            await reload();
            if (detail?.id === noteTarget.plant.id) await openPlant(noteTarget.plant.id);
          }}
        />
      )}
      {snoozePlant && (
        <SnoozeSheet
          plant={snoozePlant}
          serverDate={serverDate}
          onChoose={(nextDate) =>
            void saveSnooze(snoozePlant, nextDate)
          }
          onClose={() => setSnoozePlant(null)}
        />
      )}
      {calendarOpen && (
        <CalendarDialog
          selectedDate={serverDate}
          maxDate={actualToday.current || serverDate}
          onSelect={(day) => {
            void loadDashboardDate(day);
            setCalendarOpen(false);
          }}
          onClose={() => setCalendarOpen(false)}
        />
      )}
    </main>
  );
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty">
      <Sprout size={40} />
      <h2>Your routine starts here</h2>
      <p>Add each pot and record watering to learn its usual interval.</p>
      <button className="water" onClick={onAdd}>
        <Plus /> Add your first plant
      </button>
    </div>
  );
}
function Loading() {
  return (
    <div className="empty">
      <p>Loading your pots…</p>
    </div>
  );
}

function PlantDetailView({
  detail,
  activeDate,
  dayWateredCheckId,
  fertilizers,
  onBack,
  onRefresh,
  onUpdate,
  onWater,
  onUndo,
  onSnooze,
  onArchive,
  onDelete,
}: {
  detail: PlantDetail;
  activeDate: string;
  dayWateredCheckId: number | null;
  fertilizers: Fertilizer[];
  onBack: () => void;
  onRefresh: () => void;
  onUpdate: (data: Record<string, unknown>, photo: File | null) => Promise<void>;
  onWater: (plant: Plant) => Promise<void>;
  onUndo: (plant: Plant, checkId: number) => Promise<void>;
  onSnooze: (plant: Plant) => void;
  onArchive: () => void;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<
    "view" | "edit" | "journal" | "photos" | "fertilizer"
  >("view");
  const [date, setDate] = useState(activeDate);
  const [product, setProduct] = useState("");
  const [previewPhoto, setPreviewPhoto] = useState<TimelineEvent | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileMenuId, setProfileMenuId] = useState<number | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [editingWatering, setEditingWatering] = useState<{
    id: number;
    careDate: string;
  } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [addingWatering, setAddingWatering] = useState(false);
  const [carePending, setCarePending] = useState(false);
  const [selectedWateringDate, setSelectedWateringDate] = useState<string | null>(null);
  const wateringEvents = detail.timeline.filter(
    (event) => event.type === "watering" || (event.type === "check" && event.outcome === "watered"),
  );
  const selectedWateringEvents = wateringEvents.filter(
    (event) => wateringEventDate(event) === selectedWateringDate,
  );
  const photoGroups = Array.from(
    detail.timeline
      .filter((event) => event.type === "photo")
      .reduce((groups, event) => {
        const day = wateringEventDate(event);
        groups.set(day, [...(groups.get(day) || []), event]);
        return groups;
      }, new Map<string, TimelineEvent[]>()),
  );
  const handleCareAction = async () => {
    setCarePending(true);
    try {
      if (dayWateredCheckId) await onUndo(detail, dayWateredCheckId);
      else await onWater(detail);
    } finally {
      setCarePending(false);
    }
  };
  if (mode === "edit")
    return (
      <section className="page panel">
        <button className="back" onClick={() => setMode("view")}>
          ‹ Back
        </button>
        <PlantForm
          initial={detail}
          onSave={async (data, photo) => {
            await onUpdate(data, photo);
            setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      </section>
    );
  return (
    <section className="page detail">
      <button className="back" onClick={onBack}>
        ‹ Today
      </button>
      <div className="detail-hero">
        <Avatar plant={detail} large />
        <div>
          <h2>{detail.display_name}</h2>
          <p>
            {detail.species}
            {detail.location ? ` · ${detail.location}` : ""}
          </p>
          <strong className="detail-watered">
            {!detail.last_watered && detail.started_on ? "Started on: " : "Last watered: "}{lastWateredLabel(detail)}
            <span
              className={`signal-dot ${detail.watering_signal.level}`}
              role="img"
              aria-label={signalText(detail)}
            />
          </strong>
          <small>
            {detail.last_watered || detail.started_on || "No date recorded"} · {signalText(detail)} ·{" "}
            {patternText(detail)}
          </small>
        </div>
        <div className="detail-controls">
          <button
            className="icon-button"
            aria-label="Plant notebook"
            aria-pressed={mode === "journal"}
            onClick={() => setMode((current) => current === "journal" ? "view" : "journal")}
          >
            <NotebookPen size={19} />
          </button>
          <button
            className="icon-button"
            aria-label="Plant photos"
            aria-pressed={mode === "photos"}
            onClick={() => setMode((current) => current === "photos" ? "view" : "photos")}
          >
            <Images size={19} />
          </button>
          <button
            className="icon-button"
            aria-label="Edit plant"
            onClick={() => setMode("edit")}
          >
            <Pencil size={19} />
          </button>
          <div className="detail-menu">
            <button
              className="icon-button"
              aria-label="Plant options"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreVertical size={19} />
            </button>
            {menuOpen && (
              <div className="kebab-menu" role="menu">
                <button
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                >
                  Archive plant
                </button>
                <button
                  role="menuitem"
                  className="delete-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowDelete(true);
                  }}
                >
                  Delete plant
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="detail-actions">
        {canSnooze(detail) && (
          <button className="secondary" onClick={() => onSnooze(detail)}>
            Snooze
          </button>
        )}
        <button
          className={dayWateredCheckId ? "secondary" : "water"}
          disabled={carePending}
          onClick={() => void handleCareAction()}
        >
          <Droplets size={16} /> {dayWateredCheckId ? "Undo" : "Watered"}
        </button>
      </div>
      <div className="quick-tools">
        <button onClick={() => setMode("fertilizer")}>
          <Flower2 />
          Fertilizer
        </button>
      </div>
      {detail.care_note && (
        <section className="care-note">
          <div>
            <h3>Care instructions</h3>
            <p>{detail.care_note}</p>
          </div>
        </section>
      )}
      {mode === "journal" && (
        <section className="notebook">
          <h3 className="section-title">Plant notebook</h3>
          <section className="timeline notebook-entries">
            {detail.timeline.filter((event) => event.type === "journal").length ? (
              detail.timeline
                .filter((event) => event.type === "journal")
                .map((event) => (
                  <article className="timeline-event" key={`notebook-${event.id}`}>
                    <span className="event-date">
                      {String(event.care_date || event.created_at).slice(0, 10)}
                    </span>
                    <div>
                      <strong>Note</strong>
                      {typeof event.body === "string" && <p>{event.body}</p>}
                    </div>
                  </article>
                ))
            ) : (
              <p className="muted">No notes yet. Add one from a plant card for a selected date.</p>
            )}
          </section>
        </section>
      )}
      {mode === "photos" && (
        <section className="photo-history">
          <h3 className="section-title">Plant photos</h3>
          {photoGroups.length ? (
            <div className="photo-history-groups">
              {photoGroups.map(([day, events]) => (
                <section className="photo-day-group" key={day}>
                  <h4>{formatCareDate(day)}</h4>
                  <div className="photo-grid">
                    {events.map((event) => {
                      const isProfile = detail.profile_photo_source_id === event.id;
                      return (
                        <article className="photo-history-card" key={`photo-${event.id}`}>
                          <button
                            className="photo-history-item"
                            aria-label={`View photo from ${formatCareDate(day)}`}
                            onClick={() => setPreviewPhoto(event)}
                          >
                            <img src={`/api/photos/${event.id}?thumbnail=true`} alt={String(event.caption || "Plant progress photo")} />
                          </button>
                          <button
                            className="photo-history-menu-button"
                            aria-label={`Photo options for ${formatCareDate(day)}`}
                            aria-expanded={profileMenuId === event.id}
                            onClick={() => setProfileMenuId((id) => id === event.id ? null : event.id)}
                          >
                            <MoreVertical size={18} />
                          </button>
                          {isProfile && <span className="photo-profile-badge"><Camera size={14} /> Profile photo</span>}
                          {profileMenuId === event.id && (
                            <div className="photo-history-menu" role="menu">
                              <button
                                role="menuitem"
                                disabled={isProfile}
                                onClick={async () => {
                                  await api.setProfilePhotoFromGallery(event.id);
                                  setProfileMenuId(null);
                                  onRefresh();
                                }}
                              >
                                {isProfile ? "Current profile photo" : "Set as profile photo"}
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className="muted">No photos yet. Add one from a plant card for a selected date.</p>
          )}
        </section>
      )}
      {mode === "fertilizer" && (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (product) {
              await api.fertilizerEvent(detail.id, {
                product_id: Number(product),
                care_date: date,
              });
              setMode("view");
              onRefresh();
            }
          }}
        >
          <label>
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <select
            required
            value={product}
            onChange={(e) => setProduct(e.target.value)}
          >
            <option value="">Select product</option>
            {fertilizers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="water">Record fertilizer</button>
        </form>
      )}
      <h3 className="section-title">Watering calendar</h3>
      {historyError && <p className="history-error">{historyError}</p>}
      <WateringCalendar
        events={wateringEvents}
        selectedDate={selectedWateringDate}
        onSelectDate={setSelectedWateringDate}
      />
      {selectedWateringDate && (
        <section className="watering-day-details" aria-live="polite">
          <div className="watering-day-heading">
            <h4>
              {new Date(`${selectedWateringDate}T12:00:00`).toLocaleDateString()}
            </h4>
            <button
              className="water"
              disabled={addingWatering}
              onClick={async () => {
                setAddingWatering(true);
                setHistoryError("");
                try {
                  await api.watering(detail.id, { care_date: selectedWateringDate });
                  onRefresh();
                } catch (error) {
                  setHistoryError(
                    error instanceof Error
                      ? error.message
                      : "Could not add this watering.",
                  );
                } finally {
                  setAddingWatering(false);
                }
              }}
            >
              <Droplets size={16} />
              {addingWatering ? "Adding…" : "Add watering"}
            </button>
          </div>
          {!selectedWateringEvents.length && (
            <p className="muted">No watering recorded on this date.</p>
          )}
          {selectedWateringEvents.map((event) => (
            <div className="watering-day-record" key={`${event.type}-${event.id}`}>
              <strong>{event.type === "check" ? "Watered during check" : "Watered"}</strong>
              {event.type === "watering" &&
                (editingWatering?.id === event.id ? (
                  <form
                    className="watering-edit"
                    onSubmit={async (formEvent) => {
                      formEvent.preventDefault();
                      try {
                        await api.updateWatering(event.id, {
                          care_date: editingWatering.careDate,
                        });
                        setEditingWatering(null);
                        setSelectedWateringDate(null);
                        setHistoryError("");
                        onRefresh();
                      } catch (error) {
                        setHistoryError(
                          error instanceof Error
                            ? error.message
                            : "Could not update this watering.",
                        );
                      }
                    }}
                  >
                    <label>
                      Watering date
                      <input
                        aria-label="Watering date"
                        type="date"
                        value={editingWatering.careDate}
                        onChange={(inputEvent) =>
                          setEditingWatering({
                            ...editingWatering,
                            careDate: inputEvent.target.value,
                          })
                        }
                      />
                    </label>
                    <button className="secondary">Save date</button>
                    <button
                      type="button"
                      className="timeline-cancel"
                      onClick={() => setEditingWatering(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="timeline-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setEditingWatering({
                          id: event.id,
                          careDate: String(event.care_date),
                        });
                        setHistoryError("");
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="delete-menu-item"
                      onClick={async () => {
                        if (!confirm("Delete this watering record?")) return;
                        try {
                          await api.deleteWatering(event.id);
                          setSelectedWateringDate(null);
                          setHistoryError("");
                          onRefresh();
                        } catch (error) {
                          setHistoryError(
                            error instanceof Error
                              ? error.message
                              : "Could not delete this watering.",
                          );
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </section>
      )}
      {showDelete && (
        <DeletePlantDialog
          plant={detail}
          onDelete={onDelete}
          onClose={() => setShowDelete(false)}
        />
      )}
      {previewPhoto && (
        <div className="photo-preview-backdrop" role="presentation" onClick={() => setPreviewPhoto(null)}>
          <section className="photo-preview" role="dialog" aria-modal="true" aria-label="Plant photo" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button" aria-label="Close photo" onClick={() => setPreviewPhoto(null)}><X /></button>
            <img src={`/api/photos/${previewPhoto.id}`} alt={String(previewPhoto.caption || "Plant progress photo")} />
            <time dateTime={wateringEventDate(previewPhoto)}>{formatCareDate(wateringEventDate(previewPhoto))}</time>
          </section>
        </div>
      )}
    </section>
  );
}
function FertilizerView({
  products,
  onChanged,
}: {
  products: Fertilizer[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <section className="page">
      <form
        className="panel form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.createFertilizer({ name, description });
          setName("");
          setDescription("");
          onChanged();
        }}
      >
        <h2>Add fertilizer</h2>
        <label>
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button className="water">Add product</button>
      </form>
      <h2 className="section-title">Your products</h2>
      <div className="simple-list">
        {products.map((product) => (
          <div key={product.id}>
            <Flower2 />
            <span>
              <strong>{product.name}</strong>
              <small>{product.description}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
function Settings({ onRestored, pwaInstall }: { onRestored: () => void; pwaInstall: PwaInstallState }) {
  const [file, setFile] = useState<File | null>(null);
  const [legacyFile, setLegacyFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [legacyConfirmation, setLegacyConfirmation] = useState("");
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [schedule, setSchedule] = useState<BackupSettings | null>(null);
  const [showSafety, setShowSafety] = useState(false);
  const [pending, setPending] = useState<{ type: "restore" | "delete"; item: BackupFile } | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [items, settings] = await Promise.all([api.backups(), api.backupSettings()]);
    setBackups(items); setSchedule(settings);
  }, []);
  useEffect(() => { void load().catch(error => setMessage(error instanceof Error ? error.message : "Could not load backups.")); }, [load]);
  const saveDownload = (item: { blob: Blob; filename: string }) => {
    const url = URL.createObjectURL(item.blob); const link = document.createElement("a");
    link.href = url; link.download = item.filename; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const visibleBackups = backups.filter(item => showSafety || !item.safety);
  return (
    <section className="page">
      <section className="panel settings">
        <h2>Backup and restore</h2>
        <p>Backups include your plants, care history, photos, and fertilizer records.</p>
        <button className="water" onClick={() => void (async () => { try { saveDownload(await api.createBackup()); setMessage("Backup created and downloaded."); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Backup failed."); } })()}>
          <Download size={16} /> Create backup
        </button>
        <label><input type="checkbox" checked={showSafety} onChange={event => setShowSafety(event.target.checked)} /> Show safety backups</label>
        {visibleBackups.length === 0 ? <p className="muted">No server backups yet.</p> : <div className="simple-list">{visibleBackups.map(item => <div key={item.filename}><span><strong>{item.category.replace("-", " ")}</strong><small>{new Date(item.createdAt).toLocaleString()} · {Math.max(1, Math.round(item.size / 1024))} KB</small></span><span className="quick-tools"><button onClick={() => void api.downloadBackup(item.filename).then(saveDownload).catch(error => setMessage(error.message))}>Download</button><button onClick={() => { setPending({ type: "restore", item }); setActionConfirmation(""); }}>Restore</button><button onClick={() => { setPending({ type: "delete", item }); setActionConfirmation(""); }}>Delete</button></span></div>)}</div>}
      </section>
      <form
        className="panel settings"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file || confirmation !== "RESTORE") return;
          try {
            const result = await api.restore(file, confirmation);
            setMessage(`Backup restored. Safety backup: ${result.backup}`);
            setFile(null); setConfirmation("");
            onRestored();
            await load();
          } catch (error) {
            setMessage(
              error instanceof Error ? error.message : "Restore failed.",
            );
          }
        }}
      >
        <h2>Restore uploaded backup</h2>
        <p>Only marked Plant Care backups are accepted. The current database is saved first.</p>
        <input
          required
          type="file"
          accept=".sqlite,.sqlite3,application/x-sqlite3"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <label>Type <strong>RESTORE</strong> to continue<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        <button className="secondary" disabled={!file || confirmation !== "RESTORE"}>
          <Upload size={16} /> Restore backup
        </button>
      </form>
      <form className="panel settings" onSubmit={async event => { event.preventDefault(); if (!legacyFile || legacyConfirmation !== "IMPORT") return; try { const result = await api.importLegacy(legacyFile, legacyConfirmation); setMessage(`Database imported. Safety backup: ${result.backup}`); setLegacyFile(null); setLegacyConfirmation(""); onRestored(); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed."); } }}>
        <h2>Import legacy database</h2><p>For compatible older Plant Care databases that do not have a backup marker.</p>
        <input type="file" accept=".sqlite,.sqlite3,application/x-sqlite3" onChange={event => setLegacyFile(event.target.files?.[0] || null)} />
        <label>Type <strong>IMPORT</strong> to continue<input value={legacyConfirmation} onChange={event => setLegacyConfirmation(event.target.value)} /></label>
        <button className="danger" disabled={!legacyFile || legacyConfirmation !== "IMPORT"}>Replace database</button>
      </form>
      {schedule && <form className="panel settings" onSubmit={event => { event.preventDefault(); void api.saveBackupSettings(schedule).then(value => { setSchedule(value); setMessage("Backup schedule saved."); }).catch(error => setMessage(error.message)); }}>
        <h2>Backup schedule</h2><label><input type="checkbox" checked={schedule.dailyEnabled} onChange={event => setSchedule({ ...schedule, dailyEnabled: event.target.checked })} /> Daily backups</label><label>Time<input type="time" value={schedule.dailyTime} onChange={event => setSchedule({ ...schedule, dailyTime: event.target.value })} /></label><label>Keep<input type="number" min="1" max="365" value={schedule.dailyRetention} onChange={event => setSchedule({ ...schedule, dailyRetention: Number(event.target.value) })} /></label><label><input type="checkbox" checked={schedule.weeklyEnabled} onChange={event => setSchedule({ ...schedule, weeklyEnabled: event.target.checked })} /> Weekly backups</label><label>Day<select value={schedule.weeklyDay} onChange={event => setSchedule({ ...schedule, weeklyDay: Number(event.target.value) })}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label><label>Time<input type="time" value={schedule.weeklyTime} onChange={event => setSchedule({ ...schedule, weeklyTime: event.target.value })} /></label><label>Keep<input type="number" min="1" max="365" value={schedule.weeklyRetention} onChange={event => setSchedule({ ...schedule, weeklyRetention: Number(event.target.value) })} /></label><label>Safety backups to keep<input type="number" min="1" max="365" value={schedule.safetyRetention} onChange={event => setSchedule({ ...schedule, safetyRetention: Number(event.target.value) })} /></label><button className="secondary">Save schedule</button>
      </form>}
      {pending && <section className="panel settings"><h2>{pending.type === "restore" ? "Restore backup" : "Delete backup"}</h2><p>{pending.type === "restore" ? "The current database will be replaced after validation and a safety backup." : "This permanently removes the selected backup file."}</p><strong>{pending.item.filename}</strong><label>Type <strong>{pending.type === "restore" ? "RESTORE" : "DELETE"}</strong> to continue<input autoFocus value={actionConfirmation} onChange={event => setActionConfirmation(event.target.value)} /></label><button className="danger" disabled={actionConfirmation !== (pending.type === "restore" ? "RESTORE" : "DELETE")} onClick={() => void (async () => { try { if (pending.type === "restore") { const result = await api.restoreSavedBackup(pending.item.filename, actionConfirmation); setMessage(`Backup restored. Safety backup: ${result.backup}`); onRestored(); } else { await api.deleteBackup(pending.item.filename, actionConfirmation); setMessage("Backup deleted."); } setPending(null); setActionConfirmation(""); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Backup action failed."); } })()}>{pending.type === "restore" ? "Restore database" : "Delete backup"}</button><button type="button" className="secondary" onClick={() => setPending(null)}>Cancel</button></section>}
      {message && <p className="muted">{message}</p>}
      <InstallAppPanel state={pwaInstall} />
    </section>
  );
}
