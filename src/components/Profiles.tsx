import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Lock, Plus, ShieldCheck } from "lucide-react";
import { account, useAccount } from "../lib/account";
import { PIN_LENGTH, validPin } from "../lib/pin";
import { ageLimits, managementGuard, MAX_PROFILES, profileColors, profiles, useProfiles, type Profile } from "../lib/profiles";
import { useTmdbConfigured } from "../lib/tmdb";
import { MAIN_PROFILE } from "../lib/store";
import { errorMessage } from "../lib/utils";
import { Dialog, Segmented, Spinner, Switch, useMenu } from "./Primitives";
import { WindowControls } from "./WindowControls";

export function ProfileAvatar({ profile, size = 28 }: { profile: Pick<Profile, "name" | "color" | "pin">; size?: number }) {
  return (
    <span
      className="profile-avatar"
      aria-hidden="true"
      style={{ "--profile-color": profile.color, width: size, height: size, fontSize: Math.round(size * 0.42) } as CSSProperties}
    >
      {profile.name.charAt(0).toLocaleUpperCase("es")}
      {profile.pin && size >= 28 && (
        <span className="profile-lock">
          <Lock size={Math.max(10, Math.round(size * 0.18))} strokeWidth={2.4} />
        </span>
      )}
    </span>
  );
}

/** Moves focus between siblings with the arrow keys. */
function arrows(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  event.preventDefault();
  const items = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-profile]") ?? [])];
  const index = items.indexOf(event.currentTarget);
  items[(index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]?.focus();
}

function allowsAdultLabel(profile: Profile): string {
  return profile.showAdult && !profile.kids ? "Adultos" : "";
}

/** A field for a PIN: digits only, hidden, submitted as soon as it is complete. */
function PinField({
  label,
  onComplete,
  disabled,
}: {
  label: string;
  onComplete: (pin: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <input
      className="input pin-input"
      type="password"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      placeholder={"•".repeat(PIN_LENGTH)}
      maxLength={PIN_LENGTH}
      autoFocus
      data-autofocus
      disabled={disabled}
      value={value}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
        setValue(digits);
        if (validPin(digits)) {
          setValue("");
          onComplete(digits);
        }
      }}
    />
  );
}

type PinRequest = { profile: Profile; title: string; description?: ReactNode; action: (pin: string) => Promise<void> };

/** Asks for a profile's PIN and runs an action with it; without a PIN, the action runs at once. */
export function usePinGate(onError?: (message: string) => void) {
  const [request, setRequest] = useState<PinRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = useCallback(
    (value: PinRequest) => {
      if (!value.profile.pin) {
        void value.action("").catch((cause) => onError?.(errorMessage(cause)));
        return;
      }
      setError("");
      setRequest(value);
    },
    [onError],
  );
  const submit = async (pin: string) => {
    if (!request) return;
    setBusy(true);
    try {
      await request.action(pin);
      setRequest(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const element = request && (
    <Dialog title={request.title} onClose={() => setRequest(null)} className="compact-dialog pin-dialog" hideClose>
      <ProfileAvatar profile={request.profile} size={56} />
      <h2>{request.title}</h2>
      {request.description && <p>{request.description}</p>}
      <div className="pin-row">
        <PinField label={`PIN de ${request.profile.name}`} onComplete={(pin) => void submit(pin)} disabled={busy} />
        {busy && <Spinner />}
      </div>
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="form-actions">
        <button className="button secondary" onClick={() => setRequest(null)}>
          Cancelar
        </button>
      </div>
    </Dialog>
  );
  return { ask, element };
}

/** Opens a profile, asking for its PIN when it has one. */
export function openProfile(gate: ReturnType<typeof usePinGate>, profile: Profile, then?: () => void) {
  gate.ask({
    profile,
    title: `PIN de ${profile.name}`,
    action: async (pin) => {
      if (profile.pin) await profiles.unlock(profile.id, pin);
      else profiles.select(profile.id);
      then?.();
    },
  });
}

/** «¿Quién está viendo?», shown when Vela opens with more than one profile or a locked one. */
export function ProfilePicker({ onManage }: { onManage: () => void }) {
  const { profiles: list, last, active } = useProfiles();
  const ref = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const gate = usePinGate(setError);
  useEffect(() => {
    const index = Math.max(0, list.findIndex((profile) => profile.id === last));
    ref.current?.querySelectorAll<HTMLElement>("[data-profile]")[index]?.focus();
  }, [last, list]);
  const add = () => {
    try {
      profiles.select(profiles.create(name).id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const manager = list.find((profile) => profile.id === (last ?? active)) ?? list[0];
  return (
    <div className="profile-picker" role="dialog" aria-modal="true" aria-labelledby="profile-picker-title">
      <div className="profile-picker-bar" data-tauri-drag-region>
        <WindowControls onError={() => {}} />
      </div>
      <h1 id="profile-picker-title">¿Quién está viendo?</h1>
      <div className="profile-list" ref={ref}>
        {list.map((profile) => (
          <button
            key={profile.id}
            className="profile-choice"
            data-profile
            aria-label={profile.pin ? `${profile.name} (con PIN)` : profile.name}
            onKeyDown={arrows}
            onClick={() => openProfile(gate, profile)}
          >
            <ProfileAvatar profile={profile} size={84} />
            <span>{profile.name}</span>
          </button>
        ))}
        {list.length < MAX_PROFILES && !adding && (
          <button className="profile-choice add" data-profile onKeyDown={arrows} onClick={() => setAdding(true)}>
            <span className="profile-avatar add" style={{ width: 84, height: 84 }}>
              <Plus size={28} strokeWidth={1.5} />
            </span>
            <span>Añadir</span>
          </button>
        )}
      </div>
      {adding && (
        <form
          className="profile-add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            className="input"
            autoFocus
            aria-label="Nombre del perfil"
            placeholder="Nombre"
            maxLength={24}
            value={name}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
          <button className="button primary" disabled={!name.trim()}>
            Crear
          </button>
          <button type="button" className="button subtle" onClick={() => (setAdding(false), setName(""), setError(""))}>
            Cancelar
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      )}
      {!adding && error && <p className="form-error" role="alert">{error}</p>}
      {manager && (
        <button className="link-button profile-manage" onClick={() => openProfile(gate, manager, onManage)}>
          Administrar perfiles
        </button>
      )}
      {gate.element}
    </div>
  );
}

/** Sets or changes a profile's PIN: the current one first (if any), then the new one twice. */
function PinEditor({ profile, onClose, notify }: { profile: Profile; onClose: () => void; notify: (message: string) => void }) {
  const [step, setStep] = useState<"current" | "new" | "confirm">(profile.pin ? "current" : "new");
  const [current, setCurrent] = useState("");
  const [first, setFirst] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const title = profile.pin ? `Cambiar el PIN de ${profile.name}` : `Definir un PIN para ${profile.name}`;
  const finish = async (pin: string) => {
    if (pin !== first) {
      setError("Los PIN no coinciden. Escríbelo de nuevo.");
      setFirst("");
      setStep("new");
      return;
    }
    setBusy(true);
    try {
      await profiles.setPin(profile.id, pin, current);
      notify(profile.pin ? `PIN de «${profile.name}» cambiado.` : `«${profile.name}» pedirá su PIN al abrirse.`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setStep(profile.pin ? "current" : "new");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} className="compact-dialog pin-dialog" hideClose>
      <ProfileAvatar profile={profile} size={56} />
      <h2>{title}</h2>
      <p>
        {step === "current"
          ? "Escribe el PIN actual."
          : step === "new"
            ? `Elige ${PIN_LENGTH} cifras. Vela lo pedirá al abrir el perfil, al cambiar su PIN y al eliminarlo.`
            : "Escríbelo otra vez para confirmarlo."}
      </p>
      <div className="pin-row">
        <PinField
          key={step}
          label={step === "current" ? "PIN actual" : step === "new" ? "PIN nuevo" : "Confirma el PIN nuevo"}
          disabled={busy}
          onComplete={(pin) => {
            setError("");
            if (step === "current") {
              setBusy(true);
              void profiles
                .verify(profile.id, pin)
                .then(() => (setCurrent(pin), setStep("new")))
                .catch((cause) => setError(errorMessage(cause)))
                .finally(() => setBusy(false));
            } else if (step === "new") {
              setFirst(pin);
              setStep("confirm");
            } else void finish(pin);
          }}
        />
        {busy && <Spinner />}
      </div>
      <p className="form-error" role="alert">
        {error}
      </p>
      <p className="settings-note">El PIN evita que otros abran el perfil en este equipo; no cifra sus datos.</p>
      <div className="form-actions">
        <button className="button secondary" onClick={onClose}>
          Cancelar
        </button>
      </div>
    </Dialog>
  );
}

/** What a profile may see: adult content and an age limit from TMDB's ratings. */
function ContentDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const live = useProfiles().profiles.find((item) => item.id === profile.id) ?? profile;
  const configured = useTmdbConfigured();
  const limit = live.maxAge === undefined ? "none" : String(live.maxAge);
  return (
    <Dialog title={`Contenido de ${live.name}`} onClose={onClose} className="compact-dialog wide content-dialog" hideClose>
      <h2>Contenido de «{live.name}»</h2>
      <div className="content-option">
        <div>
          <strong>Contenido para adultos</strong>
          <p>
            Addons que se declaran para adultos y títulos que TMDB marca como pornográficos.
            {live.kids ? " Los perfiles infantiles nunca lo muestran." : ""}
          </p>
        </div>
        <Switch
          checked={Boolean(live.showAdult) && !live.kids}
          label="Mostrar contenido para adultos"
          disabled={live.kids}
          onChange={() => profiles.update(live.id, { showAdult: !live.showAdult })}
        />
      </div>
      <div className="content-option column">
        <div>
          <strong>Edad máxima</strong>
          <p>
            Oculta en Inicio, Explorar y la búsqueda los títulos clasificados para más edad, y no deja abrirlos. Usa la
            clasificación de España en TMDB (o la de EE. UU. si no hay).
          </p>
        </div>
        <Segmented
          label="Edad máxima"
          value={limit}
          onChange={(value) => profiles.update(live.id, { maxAge: value === "none" ? null : Number(value) })}
          options={[
            { value: "none", label: <span className="segment-text">Sin límite</span>, title: "Sin límite" },
            ...ageLimits.map((age) => ({
              value: String(age),
              label: <span className="segment-text">{age === 18 ? "+18" : `Hasta ${age}`}</span>,
              title: age === 18 ? "Todo salvo contenido para adultos" : `Títulos para ${age} años o menos`,
              disabled: !configured,
            })),
          ]}
        />
        {!configured && <p className="status">Necesita una clave de TMDB (Ajustes › Información).</p>}
      </div>
      {live.maxAge !== undefined && (
        <div className="content-option">
          <div>
            <strong>Títulos sin clasificar</strong>
            <p>Muchos títulos no tienen clasificación en ningún país. Ocultarlos es más seguro para niños.</p>
          </div>
          <Switch
            checked={Boolean(live.hideUnrated)}
            label="Ocultar títulos sin clasificar"
            onChange={() => profiles.update(live.id, { hideUnrated: !live.hideUnrated })}
          />
        </div>
      )}
      <p className="settings-note">
        Para que nadie cambie estos límites, pon un PIN al perfil «Principal»: desde un perfil infantil hará falta para
        administrar los perfiles.
      </p>
      <div className="form-actions">
        <button className="button primary" data-autofocus onClick={onClose}>
          Hecho
        </button>
      </div>
    </Dialog>
  );
}

/** Settings › Perfiles. */
export function ProfileSettings({ notify }: { notify: (message: string) => void }) {
  const state = useProfiles();
  const { profiles: list, active } = state;
  const accountState = useAccount();
  const linked = account.profile();
  const menu = useMenu();
  const gate = usePinGate(notify);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Profile | null>(null);
  const [editingPin, setEditingPin] = useState<Profile | null>(null);
  const [editingContent, setEditingContent] = useState<Profile | null>(null);
  const guard = managementGuard(state);
  const [unlocked, setUnlocked] = useState(false);
  const rename = (profile: Profile, value: string) => {
    if (value.trim() === profile.name) return;
    try {
      profiles.update(profile.id, { name: value });
    } catch (cause) {
      notify(errorMessage(cause));
    }
  };
  if (guard && !unlocked)
    return (
      <div className="settings-card">
        <div className="settings-row profile-guard">
          <Lock size={16} />
          <span>Para administrar los perfiles desde un perfil infantil hace falta el PIN de «{guard.name}».</span>
          <button
            className="button secondary small"
            onClick={() =>
              gate.ask({
                profile: guard,
                title: `PIN de ${guard.name}`,
                action: async (pin) => {
                  await profiles.verify(guard.id, pin);
                  setUnlocked(true);
                },
              })
            }
          >
            Introducir PIN
          </button>
        </div>
        {gate.element}
      </div>
    );
  const pinMenu = (profile: Profile, anchor: HTMLElement) => {
    if (!profile.pin) return setEditingPin(profile);
    const rect = anchor.getBoundingClientRect();
    menu.open(
      { x: rect.left, y: rect.bottom + 4 },
      [
        { label: "Cambiar PIN", onSelect: () => setEditingPin(profile) },
        {
          label: "Quitar PIN",
          danger: true,
          onSelect: () =>
            gate.ask({
              profile,
              title: `Quitar el PIN de ${profile.name}`,
              description: "Escribe el PIN actual. El perfil se abrirá sin pedirlo.",
              action: async (pin) => {
                await profiles.setPin(profile.id, null, pin);
                notify(`«${profile.name}» ya no pide PIN.`);
              },
            }),
        },
      ],
      `PIN de ${profile.name}`,
    );
  };
  return (
    <div className="settings-card">
      {list.map((profile) => (
        <div className="settings-row profile-row" key={profile.id}>
          <button
            className="profile-color-button"
            aria-label={`Color de ${profile.name}`}
            aria-haspopup="menu"
            title="Cambiar color"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              menu.open(
                { x: rect.left, y: rect.bottom + 4 },
                profileColors.map((color, index) => ({
                  label: ["Lima", "Azul", "Melocotón", "Lavanda", "Turquesa", "Rosa", "Arena", "Verde"][index],
                  icon: <span className="profile-swatch" style={{ background: color }} />,
                  checked: profile.color === color,
                  onSelect: () => profiles.update(profile.id, { color }),
                })),
                `Color de ${profile.name}`,
              );
            }}
          >
            <ProfileAvatar profile={profile} size={32} />
          </button>
          <input
            className="input profile-name"
            aria-label={`Nombre del perfil ${profile.name}`}
            defaultValue={profile.name}
            maxLength={24}
            key={profile.name}
            onBlur={(event) => rename(profile, event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
          <span className="profile-meta">
            {[
              profile.id === active ? "En uso" : "",
              profile.kids ? "Infantil" : "",
              profile.pin ? "Con PIN" : "",
              profile.maxAge !== undefined ? (profile.maxAge === 18 ? "+18" : `Hasta ${profile.maxAge}`) : "",
              allowsAdultLabel(profile),
              linked === profile.id && accountState.user ? `Cuenta de Stremio` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <div className="profile-actions">
            {profile.id !== MAIN_PROFILE && (
              <button
                className={`chip ${profile.kids ? "selected" : ""}`}
                aria-pressed={Boolean(profile.kids)}
                title="Solo catálogos infantiles en Inicio, Explorar y la búsqueda"
                onClick={() => profiles.update(profile.id, { kids: !profile.kids })}
              >
                Infantil
              </button>
            )}
            <button
              className={`chip ${profile.pin ? "selected" : ""}`}
              aria-haspopup={profile.pin ? "menu" : "dialog"}
              title={profile.pin ? "Cambiar o quitar el PIN" : "Pedir un PIN al abrir este perfil"}
              onClick={(event) => pinMenu(profile, event.currentTarget)}
            >
              <Lock size={12} /> PIN
            </button>
            <button
              className={`chip ${profile.maxAge !== undefined ? "selected" : ""}`}
              aria-haspopup="dialog"
              title="Contenido para adultos y edad máxima"
              onClick={() => setEditingContent(profile)}
            >
              <ShieldCheck size={12} /> Contenido
            </button>
            {profile.id !== active && (
              <button
                className="button subtle small"
                onClick={() => openProfile(gate, profile, () => notify(`Perfil: ${profile.name}`))}
              >
                Usar
              </button>
            )}
            {profile.id !== MAIN_PROFILE && profile.id !== active && (
              <button className="button subtle small danger-text" onClick={() => setRemoving(profile)}>
                Eliminar
              </button>
            )}
          </div>
        </div>
      ))}
      {list.length < MAX_PROFILES && (
        <form
          className="settings-row profile-row"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const profile = profiles.create(name);
              setName("");
              notify(`Perfil «${profile.name}» creado.`);
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }}
        >
          <span className="profile-avatar add" style={{ width: 32, height: 32 }} aria-hidden="true">
            <Plus size={15} />
          </span>
          <input
            className="input profile-name"
            aria-label="Nombre del nuevo perfil"
            placeholder="Nuevo perfil"
            maxLength={24}
            value={name}
            onChange={(event) => (setName(event.target.value), setError(""))}
          />
          <span className="profile-meta">{error && <span className="status error">{error}</span>}</span>
          <div className="profile-actions">
            <button className="button secondary small" disabled={!name.trim()}>
              Añadir
            </button>
          </div>
        </form>
      )}
      <p className="settings-note">
        Cada perfil tiene su biblioteca, su progreso, sus vistos y sus preferencias de reproducción. Los addons y los servicios
        son comunes. La cuenta de Stremio se sincroniza solo con el perfil desde el que se inició sesión. Con un PIN en
        «Principal», un perfil infantil necesita ese PIN para administrar los perfiles.
      </p>
      {menu.element}
      {gate.element}
      {editingPin && <PinEditor profile={editingPin} notify={notify} onClose={() => setEditingPin(null)} />}
      {editingContent && <ContentDialog profile={editingContent} onClose={() => setEditingContent(null)} />}
      {removing && (
        <Dialog title="Eliminar perfil" onClose={() => setRemoving(null)} className="compact-dialog" hideClose>
          <h2>¿Eliminar «{removing.name}»?</h2>
          <p>Se borrarán su biblioteca, su progreso y sus preferencias de este equipo. Esta acción no se puede deshacer.</p>
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={() => setRemoving(null)}>
              Cancelar
            </button>
            <button
              className="button danger"
              onClick={() => {
                const profile = removing;
                setRemoving(null);
                gate.ask({
                  profile,
                  title: `Eliminar «${profile.name}»`,
                  description: "Escribe su PIN para eliminarlo.",
                  action: async (pin) => {
                    await profiles.remove(profile.id, pin);
                    notify(`Perfil «${profile.name}» eliminado.`);
                  },
                });
              }}
            >
              Eliminar perfil
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
