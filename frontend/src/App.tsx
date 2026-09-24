import { FormEvent, useCallback, useEffect, useState } from "react";
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
  Archive,
  BookOpen,
  Download,
  Droplets,
  Flower2,
  GripVertical,
  Leaf,
  MoreVertical,
  Pencil,
  Plus,
  Sprout,
  Upload,
  X,
} from "lucide-react";
import { api, BackupFile, BackupSettings, Dashboard, Fertilizer, Plant, PlantDetail } from "./api";
import { InstallAppPanel, type PwaInstallState } from "./components/InstallAppPanel";
import { usePwaInstall } from "./hooks/usePwaInstall";

type Page = "home" | "detail" | "fertilizer" | "settings" | "add";
function lastWateredLabel(plant: Plant) {
  const days = plant.watering_signal.days_since;
  if (!plant.last_watered || days === null) return "Never";
  if (days < 0) return plant.last_watered;
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
function dateAfter(day: string, days: number) {
  const result = new Date(`${day}T12:00:00`);
  result.setDate(result.getDate() + days);
  return result.toISOString().slice(0, 10);
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
  return plant.cover_photo_id ? (
    <img
      className={`avatar ${large ? "large" : ""}`}
      src={`/api/photos/${plant.cover_photo_id}?thumbnail=true`}
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
  onWater,
  onSnooze,
  onOpen,
}: {
  plant: Plant;
  position: number;
  onWater: (plant: Plant) => void;
  onSnooze: (plant: Plant) => void;
  onOpen: () => void;
}) {
  const sortable = useSortable({ id: plant.id });
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
      <div className="water-summary">
        <span>Last watered</span>
        <strong>{lastWateredLabel(plant)}</strong>
        <span
          className={`signal-dot ${plant.watering_signal.level}`}
          role="img"
          aria-label={signalText(plant)}
        />
        <small>{plant.last_watered || "No date recorded"}</small>
      </div>
      <div className="card-footer">
        <span>{signalText(plant)} · {patternText(plant)}</span>
        <div className="actions">
          {canSnooze(plant) && (
            <button className="secondary" onClick={() => onSnooze(plant)}>
              Snooze
            </button>
          )}
          <button className="water" onClick={() => onWater(plant)}>
            <Droplets size={16} /> Watered
          </button>
        </div>
      </div>
    </article>
  );
}

function PlantList({
  plants,
  onWater,
  onSnooze,
  onOpen,
  onReorder,
}: {
  plants: Plant[];
  onWater: (plant: Plant) => void;
  onSnooze: (plant: Plant) => void;
  onOpen: (id: number) => void;
  onReorder: (ids: number[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
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
              onWater={onWater}
              onSnooze={onSnooze}
              onOpen={() => onOpen(plant.id)}
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
  const [lastWatered, setLastWatered] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
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
          initial_last_watered: lastWatered || null,
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
        <>
          <label>
            Last watered <span className="optional">optional</span>
            <input
              type="date"
              value={lastWatered}
              onChange={(e) => setLastWatered(e.target.value)}
            />
          </label>
          <label>
            Photo <span className="optional">optional</span>
            <input
              aria-label="Plant photo"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              capture="environment"
              onChange={(event) => setPhoto(event.target.files?.[0] || null)}
            />
          </label>
        </>
      )}
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
  const [snack, setSnack] = useState<{ text: string; checkId: number } | null>(
    null,
  );
  const pwaInstall = usePwaInstall();
  const [snoozePlant, setSnoozePlant] = useState<Plant | null>(null);
  const reload = useCallback(async () => {
    try {
      const [next, products] = await Promise.all([
        api.dashboard(),
        api.fertilizers(),
      ]);
      setDashboard(next);
      setFertilizers(products);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Plant Care.");
    }
  }, []);
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
  useEffect(() => {
    if (!snack) return;
    const timer = window.setTimeout(() => setSnack(null), 8000);
    return () => clearTimeout(timer);
  }, [snack]);
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
      const result = (await api.adHocCheck(plant.id, {
        outcome: "watered",
      })) as { id: number };
      setSnack({
        text: `${plant.display_name} marked watered.`,
        checkId: result.id,
      });
      await reload();
      if (detail?.id === plant.id) await openPlant(plant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record watering.");
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
      if (photo) {
        const uploaded = await api.uploadPhoto(plant.id, photo);
        await api.setCover(uploaded.id);
      }
      await reload();
      setPage("home");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add plant.");
    }
  };
  const returnToToday = async () => {
    setDetail(null);
    setPage("home");
    await reload();
  };
  const updatePlant = async (data: Record<string, unknown>) => {
    if (!detail) return;
    try {
      const plantData = { ...data };
      delete plantData.initial_last_watered;
      await api.updatePlant(detail.id, plantData);
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
  const serverDate =
    dashboard?.server_date || new Date().toISOString().slice(0, 10);
  return (
    <main className="app-shell">
      <header>
        <div>
          <button
            type="button"
            className="eyebrow brand-link"
            aria-label="Go to Today"
            onClick={() => void returnToToday()}
          >
            <Sprout size={16} /> Plant Care
          </button>
          <h1>{title}</h1>
        </div>
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
              <section className="schedule-heading">
                <h2>
                  Your plants
                </h2>
                <p>
                  Watering signals reflect each plant&apos;s history. Check its
                  conditions before deciding to water.
                </p>
              </section>
              {dashboard.plants.length ? (
                <PlantList
                  plants={dashboard.plants}
                  onWater={(plant) => void saveWatering(plant)}
                  onSnooze={setSnoozePlant}
                  onOpen={(id) => void openPlant(id)}
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
          fertilizers={fertilizers}
          onBack={() => void returnToToday()}
          onRefresh={() => void openPlant(detail.id)}
          onUpdate={updatePlant}
          onWater={(plant) => void saveWatering(plant)}
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
      {snack && (
        <div className="snack">
          {snack.text}
          <button
            onClick={async () => {
              await api.deleteCheck(snack.checkId);
              setSnack(null);
              await reload();
            }}
          >
            Undo
          </button>
        </div>
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
  fertilizers,
  onBack,
  onRefresh,
  onUpdate,
  onWater,
  onSnooze,
  onArchive,
  onDelete,
}: {
  detail: PlantDetail;
  fertilizers: Fertilizer[];
  onBack: () => void;
  onRefresh: () => void;
  onUpdate: (data: Record<string, unknown>) => Promise<void>;
  onWater: (plant: Plant) => void;
  onSnooze: (plant: Plant) => void;
  onArchive: () => void;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<
    "view" | "edit" | "journal" | "photo" | "fertilizer"
  >("view");
  const [body, setBody] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  const [product, setProduct] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [editingWatering, setEditingWatering] = useState<{
    id: number;
    careDate: string;
  } | null>(null);
  const [historyError, setHistoryError] = useState("");
  if (mode === "edit")
    return (
      <section className="page panel">
        <button className="back" onClick={() => setMode("view")}>
          ‹ Back
        </button>
        <PlantForm
          initial={detail}
          onSave={async (data) => {
            await onUpdate(data);
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
            Last watered: {lastWateredLabel(detail)}
            <span
              className={`signal-dot ${detail.watering_signal.level}`}
              role="img"
              aria-label={signalText(detail)}
            />
          </strong>
          <small>
            {detail.last_watered || "No date recorded"} · {signalText(detail)} ·{" "}
            {patternText(detail)}
          </small>
        </div>
        <div className="detail-controls">
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
        <button className="water" onClick={() => onWater(detail)}>
          <Droplets size={16} /> Watered
        </button>
      </div>
      <div className="quick-tools">
        <button onClick={() => setMode("journal")}>
          <BookOpen />
          Journal
        </button>
        <button onClick={() => setMode("photo")}>
          <Upload />
          Photo
        </button>
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
          <button
            className="icon-button"
            aria-label="Archive plant"
            onClick={onArchive}
          >
            <Archive size={17} />
          </button>
        </section>
      )}
      {mode === "journal" && (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.journal(detail.id, { care_date: date, body });
            setBody("");
            setMode("view");
            onRefresh();
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
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What changed?"
          />
          <button className="water">Save journal entry</button>
        </form>
      )}
      {mode === "photo" && (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (file) {
              const photo = await api.uploadPhoto(detail.id, file);
              if (!detail.cover_photo_id) await api.setCover(photo.id);
              setMode("view");
              onRefresh();
            }
          }}
        >
          <input
            required
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            capture="environment"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <button className="water">Upload photo</button>
        </form>
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
      <h3 className="section-title">History</h3>
      {historyError && <p className="history-error">{historyError}</p>}
      <section className="timeline">
        {detail.timeline.length ? (
          detail.timeline.map((event) => (
            <div className="timeline-event" key={`${event.type}-${event.id}`}>
              <span className="event-date">
                {String(event.care_date || event.created_at).slice(0, 10)}
              </span>
              <div>
                <strong>
                  {event.type === "check"
                    ? event.outcome === "watered"
                      ? "Watered during check"
                      : "Checked — not watered"
                    : event.type === "watering"
                      ? "Watered"
                      : event.type === "fertilizer"
                        ? `Fertilized with ${event.product_name}`
                        : event.type === "journal"
                          ? "Journal note"
                          : "Photo added"}
                </strong>
                {typeof event.body === "string" && <p>{event.body}</p>}
                {typeof event.note === "string" && event.note && (
                  <p>{event.note}</p>
                )}
                {event.type === "photo" && (
                  <img
                    src={`/api/photos/${event.id}?thumbnail=true`}
                    alt="Plant history"
                  />
                )}
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
            </div>
          ))
        ) : (
          <p className="muted">No events yet.</p>
        )}
      </section>
      {showDelete && (
        <DeletePlantDialog
          plant={detail}
          onDelete={onDelete}
          onClose={() => setShowDelete(false)}
        />
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
