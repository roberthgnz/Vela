import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import { account, useAccount } from "../lib/account";
import { MAX_PROFILES, profileColors, profiles, useProfiles, type Profile } from "../lib/profiles";
import { MAIN_PROFILE } from "../lib/store";
import { errorMessage } from "../lib/utils";
import { Dialog, useMenu } from "./Primitives";
import { WindowControls } from "./WindowControls";

export function ProfileAvatar({ profile, size = 28 }: { profile: Pick<Profile, "name" | "color">; size?: number }) {
  return (
    <span
      className="profile-avatar"
      aria-hidden="true"
      style={{ "--profile-color": profile.color, width: size, height: size, fontSize: Math.round(size * 0.42) } as CSSProperties}
    >
      {profile.name.charAt(0).toLocaleUpperCase("es")}
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

/** «¿Quién está viendo?», shown when Vela opens with more than one profile. */
export function ProfilePicker({ onManage }: { onManage: () => void }) {
  const { profiles: list, last } = useProfiles();
  const ref = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
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
  return (
    <div className="profile-picker" role="dialog" aria-modal="true" aria-labelledby="profile-picker-title">
      <div className="profile-picker-bar" data-tauri-drag-region>
        <WindowControls onError={() => {}} />
      </div>
      <h1 id="profile-picker-title">¿Quién está viendo?</h1>
      <div className="profile-list" ref={ref}>
        {list.map((profile) => (
          <button key={profile.id} className="profile-choice" data-profile onKeyDown={arrows} onClick={() => profiles.select(profile.id)}>
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
      <button className="link-button profile-manage" onClick={onManage}>
        Administrar perfiles
      </button>
    </div>
  );
}

/** Settings › Perfiles. */
export function ProfileSettings({ notify }: { notify: (message: string) => void }) {
  const { profiles: list, active } = useProfiles();
  const accountState = useAccount();
  const linked = account.profile();
  const menu = useMenu();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Profile | null>(null);
  const rename = (profile: Profile, value: string) => {
    if (value.trim() === profile.name) return;
    try {
      profiles.update(profile.id, { name: value });
    } catch (cause) {
      notify(errorMessage(cause));
    }
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
            {[profile.id === active ? "En uso" : "", linked === profile.id && accountState.user ? `Cuenta de Stremio` : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <div className="profile-actions">
            {profile.id !== active && (
              <button className="button subtle small" onClick={() => (profiles.select(profile.id), notify(`Perfil: ${profile.name}`))}>
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
        son comunes. La cuenta de Stremio se sincroniza solo con el perfil desde el que se inició sesión.
      </p>
      {menu.element}
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
                profiles.remove(removing.id);
                notify(`Perfil «${removing.name}» eliminado.`);
                setRemoving(null);
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
