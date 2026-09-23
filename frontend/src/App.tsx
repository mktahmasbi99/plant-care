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
  Plus,
  Sprout,
  Upload,
  X,
} from "lucide-react";
import { api, Dashboard, Fertilizer, Plant, PlantDetail, Status } from "./api";

type Page = "home" | "detail" | "fertilizer" | "settings" | "add";
const statusText: Record<Status, string> = {
  never_watered: "Needs first check",
  on_track: "On track",
  due_soon: "Check tomorrow",
  due: "Due today",
  overdue: "Overdue",
};
const relative = (days: number | null) =>
  days === null
    ? "No watering recorded"
    : days === 0
      ? "Watered today"
      : days === 1
        ? "Watered yesterday"
        : `Watered ${days} days ago`;
function dateAfter(day: string, days: number) {
  const result = new Date(`${day}T12:00:00`);
  result.setDate(result.getDate() + days);
  return result.toISOString().slice(0, 10);
}
function scheduleText(plant: Plant) {
  const days = plant.status.days_until_check;
  if (plant.status.status === "never_watered") return "No watering recorded";
  if (days === 0) return "Check today";
  if (days === 1) return "Check tomorrow";
  if (days !== null && days > 1) return `Check in ${days} days`;
  return `Overdue by ${Math.abs(days || 0)} day${Math.abs(days || 0) === 1 ? "" : "s"}`;
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
  onAction,
  onOpen,
}: {
  plant: Plant;
  onAction: (plant: Plant, outcome: "watered" | "not_watered") => void;
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
      className={`plant-card ${plant.status.status} ${sortable.isDragging ? "dragging" : ""}`}
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
          <span className="card-title">{plant.display_name}</span>
          <span className="species">
            {plant.species}
            {plant.location ? ` · ${plant.location}` : ""}
          </span>
        </span>
        <span className="status-pill">{statusText[plant.status.status]}</span>
      </button>
      <div className="water-summary">
        <span>Last watered</span>
        <strong>{plant.last_watered || "Never"}</strong>
        <small>{relative(plant.status.days_since)}</small>
      </div>
      <div className="card-footer">
        <span>
          {scheduleText(plant)} · {plant.recommendation.label}
        </span>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => onAction(plant, "not_watered")}
          >
            Not watered
          </button>
          <button className="water" onClick={() => onAction(plant, "watered")}>
            <Droplets size={16} /> Watered
          </button>
        </div>
      </div>
    </article>
  );
}

function PlantList({
  plants,
  onAction,
  onOpen,
  onReorder,
}: {
  plants: Plant[];
  onAction: (plant: Plant, outcome: "watered" | "not_watered") => void;
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
          {plants.map((plant) => (
            <PlantCard
              key={plant.id}
              plant={plant}
              onAction={onAction}
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
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [species, setSpecies] = useState(initial?.species || "");
  const [nickname, setNickname] = useState(initial?.nickname || "");
  const [location, setLocation] = useState(initial?.location || "");
  const [careNote, setCareNote] = useState(initial?.care_note || "");
  const [intervalDays, setIntervalDays] = useState(
    initial?.recommendation.interval_days || 7,
  );
  const [lastWatered, setLastWatered] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        species,
        nickname,
        location,
        care_note: careNote,
        recommendation: { interval_days: intervalDays },
        initial_last_watered: lastWatered || null,
      });
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
      <fieldset>
        <legend>Check interval after watering</legend>
        <div className="cadence">
          <span>Every</span>
          <input
            aria-label="Check interval in days"
            type="number"
            min="1"
            max="365"
            value={intervalDays}
            onChange={(e) => setIntervalDays(Number(e.target.value))}
          />
          <span>days</span>
        </div>
      </fieldset>
      {!initial && (
        <label>
          Last watered <span className="optional">optional</span>
          <input
            type="date"
            value={lastWatered}
            onChange={(e) => setLastWatered(e.target.value)}
          />
        </label>
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

function RecheckSheet({
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
  const [custom, setCustom] = useState(tomorrow);
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="recheck-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recheck-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="recheck-title">Check {plant.display_name} again</h2>
        <p>It was not watered. Choose the next check date.</p>
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
            onChoose(custom);
          }}
        >
          <label>
            Pick a date
            <input
              aria-label="Custom recheck date"
              required
              min={tomorrow}
              type="date"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
          </label>
          <button className="secondary">Use this date</button>
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
  const [recheckPlant, setRecheckPlant] = useState<Plant | null>(null);
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
  const saveCheck = async (
    plant: Plant,
    outcome: "watered" | "not_watered",
    nextCheckDate?: string,
  ) => {
    if (offline) return;
    try {
      const result = (await api.adHocCheck(plant.id, {
        outcome,
        next_check_date: nextCheckDate,
      })) as { id: number };
      setSnack({
        text:
          outcome === "watered"
            ? `${plant.display_name} marked watered.`
            : `${plant.display_name} will be checked again on ${nextCheckDate}.`,
        checkId: result.id,
      });
      setRecheckPlant(null);
      await reload();
      if (detail?.id === plant.id) await openPlant(plant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that check.");
    }
  };
  const action = (plant: Plant, outcome: "watered" | "not_watered") =>
    outcome === "not_watered"
      ? setRecheckPlant(plant)
      : void saveCheck(plant, outcome);
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
  const savePlant = async (data: Record<string, unknown>) => {
    try {
      await api.createPlant(data);
      await reload();
      setPage("home");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add plant.");
    }
  };
  const returnToToday = async () => {
    await reload();
    setDetail(null);
    setPage("home");
  };
  const updatePlant = async (data: Record<string, unknown>) => {
    if (!detail) return;
    try {
      const plantData = { ...data };
      const recommendation = plantData.recommendation;
      delete plantData.recommendation;
      delete plantData.initial_last_watered;
      await api.updatePlant(detail.id, plantData);
      if (
        recommendation &&
        JSON.stringify(recommendation) !==
          JSON.stringify({ interval_days: detail.recommendation.interval_days })
      )
        await api.recommendation(detail.id, recommendation);
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
          <span className="eyebrow">
            <Sprout size={16} /> Plant Care
          </span>
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
                  {dashboard.due_count
                    ? `${dashboard.due_count} pot${dashboard.due_count === 1 ? "" : "s"} need checking today`
                    : "All pots are on schedule"}
                </h2>
                <p>
                  {dashboard.due_count
                    ? "Highlighted pots need your attention. Drag the handle to arrange your routine."
                    : "Every pot is visible below in your chosen order."}
                </p>
              </section>
              {dashboard.plants.length ? (
                <PlantList
                  plants={dashboard.plants}
                  onAction={action}
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
          onAction={action}
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
      {page === "settings" && <Settings onRestored={() => void reload()} />}
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
      {recheckPlant && (
        <RecheckSheet
          plant={recheckPlant}
          serverDate={serverDate}
          onChoose={(nextDate) =>
            void saveCheck(recheckPlant, "not_watered", nextDate)
          }
          onClose={() => setRecheckPlant(null)}
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
      <p>Add each pot with a check interval.</p>
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
  onAction,
  onArchive,
  onDelete,
}: {
  detail: PlantDetail;
  fertilizers: Fertilizer[];
  onBack: () => void;
  onRefresh: () => void;
  onUpdate: (data: Record<string, unknown>) => Promise<void>;
  onAction: (plant: Plant, outcome: "watered" | "not_watered") => void;
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
          <strong>Last watered: {detail.last_watered || "Never"}</strong>
          <small>
            {scheduleText(detail)} · {detail.recommendation.label}
          </small>
        </div>
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
      <div className="detail-actions">
        <button
          className="secondary"
          onClick={() => onAction(detail, "not_watered")}
        >
          Not watered
        </button>
        <button className="water" onClick={() => onAction(detail, "watered")}>
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
        <button onClick={() => setMode("edit")}>
          <Leaf />
          Edit
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
function Settings({ onRestored }: { onRestored: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  return (
    <section className="page">
      <section className="panel settings">
        <h2>Backup</h2>
        <p>Download one self-contained SQLite backup.</p>
        <a className="water link-button" href="/api/backups/download">
          <Download size={16} /> Download backup
        </a>
      </section>
      <form
        className="panel settings"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            !file ||
            !confirm(
              "Restore this backup? The current database will first be snapshotted.",
            )
          )
            return;
          try {
            await api.restore(file);
            setMessage("Backup restored successfully.");
            onRestored();
          } catch (error) {
            setMessage(
              error instanceof Error ? error.message : "Restore failed.",
            );
          }
        }}
      >
        <h2>Restore</h2>
        <input
          required
          type="file"
          accept=".sqlite,.sqlite3,application/x-sqlite3"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <button className="secondary">
          <Upload size={16} /> Restore backup
        </button>
        {message && <p className="muted">{message}</p>}
      </form>
    </section>
  );
}
