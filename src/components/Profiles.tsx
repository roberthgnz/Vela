import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Lock, Plus, ShieldCheck } from "lucide-react";
import { account, useAccount } from "../lib/account";
import { PIN_LENGTH, validPin } from "../lib/pin";
import { ageLimits, managementGuard, MAX_PROFILES, profileColors, profiles, useProfiles, type Profile } from "../lib/profiles";
import { useTmdbConfigured } from "../lib/tmdb";
import { MAIN_PROFILE } from "../lib/store";
import { errorMessage } from "../lib/utils";
import { t } from "../lib/i18n";
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
  return profile.showAdult && !profile.kids ? t("profiles.adult") : "";
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
        <PinField label={t("profiles.pinOf", { name: request.profile.name })} onComplete={(pin) => void submit(pin)} disabled={busy} />
        {busy && <Spinner />}
      </div>
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="form-actions">
        <button className="button secondary" onClick={() => setRequest(null)}>
          {t("common.cancel")}
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
    title: t("profiles.pinOf", { name: profile.name }),
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
      <h1 id="profile-picker-title">{t("profiles.whoIsWatching")}</h1>
      <div className="profile-list" ref={ref}>
        {list.map((profile) => (
          <button
            key={profile.id}
            className="profile-choice"
            data-profile
            aria-label={profile.pin ? t("profiles.withPin", { name: profile.name }) : profile.name}
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
            <span>{t("common.add")}</span>
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
            aria-label={t("profiles.nameLabel")}
            placeholder={t("profiles.namePlaceholder")}
            maxLength={24}
            value={name}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
          <button className="button primary" disabled={!name.trim()}>
            {t("profiles.create")}
          </button>
          <button type="button" className="button subtle" onClick={() => (setAdding(false), setName(""), setError(""))}>
            {t("common.cancel")}
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      )}
      {!adding && error && <p className="form-error" role="alert">{error}</p>}
      {manager && (
        <button className="link-button profile-manage" onClick={() => openProfile(gate, manager, onManage)}>
          {t("profiles.manage")}
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
  const title = profile.pin ? t("profiles.changePinTitle", { name: profile.name }) : t("profiles.setPinTitle", { name: profile.name });
  const finish = async (pin: string) => {
    if (pin !== first) {
      setError(t("profiles.pinMismatch"));
      setFirst("");
      setStep("new");
      return;
    }
    setBusy(true);
    try {
      await profiles.setPin(profile.id, pin, current);
      notify(profile.pin ? t("profiles.pinChanged", { name: profile.name }) : t("profiles.pinSet", { name: profile.name }));
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
          ? t("profiles.enterCurrentPin")
          : step === "new"
            ? t("profiles.chooseDigits", { length: PIN_LENGTH })
            : t("profiles.confirmAgain")}
      </p>
      <div className="pin-row">
        <PinField
          key={step}
          label={step === "current" ? t("profiles.currentPin") : step === "new" ? t("profiles.newPin") : t("profiles.confirmNewPin")}
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
      <p className="settings-note">{t("profiles.pinNote")}</p>
      <div className="form-actions">
        <button className="button secondary" onClick={onClose}>
          {t("common.cancel")}
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
    <Dialog title={t("profiles.contentOf", { name: live.name })} onClose={onClose} className="compact-dialog wide content-dialog" hideClose>
      <h2>{t("profiles.contentOfQuoted", { name: live.name })}</h2>
      <div className="content-option">
        <div>
          <strong>{t("profiles.adultContent")}</strong>
          <p>
            {t("profiles.adultContentHelp")}
            {live.kids ? t("profiles.kidsNeverAdult") : ""}
          </p>
        </div>
        <Switch
          checked={Boolean(live.showAdult) && !live.kids}
          label={t("profiles.showAdult")}
          disabled={live.kids}
          onChange={() => profiles.update(live.id, { showAdult: !live.showAdult })}
        />
      </div>
      <div className="content-option column">
        <div>
          <strong>{t("profiles.maxAge")}</strong>
          <p>
            {t("profiles.maxAgeHelp")}
          </p>
        </div>
        <Segmented
          label={t("profiles.maxAge")}
          value={limit}
          onChange={(value) => profiles.update(live.id, { maxAge: value === "none" ? null : Number(value) })}
          options={[
            { value: "none", label: <span className="segment-text">{t("profiles.noLimit")}</span>, title: t("profiles.noLimit") },
            ...ageLimits.map((age) => ({
              value: String(age),
              label: <span className="segment-text">{age === 18 ? "+18" : t("profiles.upTo", { age })}</span>,
              title: age === 18 ? t("profiles.allButAdult") : t("profiles.titlesForAge", { age }),
              disabled: !configured,
            })),
          ]}
        />
        {!configured && <p className="status">{t("profiles.needsTmdb")}</p>}
      </div>
      {live.maxAge !== undefined && (
        <div className="content-option">
          <div>
            <strong>{t("profiles.unrated")}</strong>
            <p>{t("profiles.unratedHelp")}</p>
          </div>
          <Switch
            checked={Boolean(live.hideUnrated)}
            label={t("profiles.hideUnrated")}
            onChange={() => profiles.update(live.id, { hideUnrated: !live.hideUnrated })}
          />
        </div>
      )}
      <p className="settings-note">
        {t("profiles.lockNote")}
      </p>
      <div className="form-actions">
        <button className="button primary" data-autofocus onClick={onClose}>
          {t("profiles.done")}
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
          <span>{t("profiles.guard", { name: guard.name })}</span>
          <button
            className="button secondary small"
            onClick={() =>
              gate.ask({
                profile: guard,
                title: t("profiles.pinOf", { name: guard.name }),
                action: async (pin) => {
                  await profiles.verify(guard.id, pin);
                  setUnlocked(true);
                },
              })
            }
          >
            {t("profiles.enterPin")}
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
        { label: t("profiles.changePin"), onSelect: () => setEditingPin(profile) },
        {
          label: t("profiles.removePin"),
          danger: true,
          onSelect: () =>
            gate.ask({
              profile,
              title: t("profiles.removePinTitle", { name: profile.name }),
              description: t("profiles.removePinHelp"),
              action: async (pin) => {
                await profiles.setPin(profile.id, null, pin);
                notify(t("profiles.pinRemoved", { name: profile.name }));
              },
            }),
        },
      ],
      t("profiles.pinOf", { name: profile.name }),
    );
  };
  return (
    <div className="settings-card">
      {list.map((profile) => (
        <div className="settings-row profile-row" key={profile.id}>
          <button
            className="profile-color-button"
            aria-label={t("profiles.colorOf", { name: profile.name })}
            aria-haspopup="menu"
            title={t("profiles.changeColor")}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              menu.open(
                { x: rect.left, y: rect.bottom + 4 },
                profileColors.map((color, index) => ({
                  label: [t("profiles.color.lime"), t("profiles.color.blue"), t("profiles.color.peach"), t("profiles.color.lavender"), t("profiles.color.teal"), t("profiles.color.pink"), t("profiles.color.sand"), t("profiles.color.green")][index],
                  icon: <span className="profile-swatch" style={{ background: color }} />,
                  checked: profile.color === color,
                  onSelect: () => profiles.update(profile.id, { color }),
                })),
                t("profiles.colorOf", { name: profile.name }),
              );
            }}
          >
            <ProfileAvatar profile={profile} size={32} />
          </button>
          <input
            className="input profile-name"
            aria-label={t("profiles.nameOf", { name: profile.name })}
            defaultValue={profile.name}
            maxLength={24}
            key={profile.name}
            onBlur={(event) => rename(profile, event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
          <span className="profile-meta">
            {[
              profile.id === active ? t("profiles.inUse") : "",
              profile.kids ? t("profiles.kids") : "",
              profile.pin ? t("profiles.hasPin") : "",
              profile.maxAge !== undefined ? (profile.maxAge === 18 ? "+18" : t("profiles.upTo", { age: profile.maxAge })) : "",
              allowsAdultLabel(profile),
              linked === profile.id && accountState.user ? t("profiles.stremioAccount") : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <div className="profile-actions">
            {profile.id !== MAIN_PROFILE && (
              <button
                className={`chip ${profile.kids ? "selected" : ""}`}
                aria-pressed={Boolean(profile.kids)}
                title={t("profiles.kidsTitle")}
                onClick={() => profiles.update(profile.id, { kids: !profile.kids })}
              >
                {t("profiles.kids")}
              </button>
            )}
            <button
              className={`chip ${profile.pin ? "selected" : ""}`}
              aria-haspopup={profile.pin ? "menu" : "dialog"}
              title={profile.pin ? t("profiles.pinTitleSet") : t("profiles.pinTitleUnset")}
              onClick={(event) => pinMenu(profile, event.currentTarget)}
            >
              <Lock size={12} /> PIN
            </button>
            <button
              className={`chip ${profile.maxAge !== undefined ? "selected" : ""}`}
              aria-haspopup="dialog"
              title={t("profiles.contentTitle")}
              onClick={() => setEditingContent(profile)}
            >
              <ShieldCheck size={12} /> {t("profiles.content")}
            </button>
            {profile.id !== active && (
              <button
                className="button subtle small"
                onClick={() => openProfile(gate, profile, () => notify(t("profiles.switched", { name: profile.name })))}
              >
                {t("profiles.use")}
              </button>
            )}
            {profile.id !== MAIN_PROFILE && profile.id !== active && (
              <button className="button subtle small danger-text" onClick={() => setRemoving(profile)}>
                {t("common.delete")}
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
              notify(t("profiles.created", { name: profile.name }));
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
            aria-label={t("profiles.newNameLabel")}
            placeholder={t("profiles.newPlaceholder")}
            maxLength={24}
            value={name}
            onChange={(event) => (setName(event.target.value), setError(""))}
          />
          <span className="profile-meta">{error && <span className="status error">{error}</span>}</span>
          <div className="profile-actions">
            <button className="button secondary small" disabled={!name.trim()}>
              {t("common.add")}
            </button>
          </div>
        </form>
      )}
      <p className="settings-note">
        {t("profiles.note")}
      </p>
      {menu.element}
      {gate.element}
      {editingPin && <PinEditor profile={editingPin} notify={notify} onClose={() => setEditingPin(null)} />}
      {editingContent && <ContentDialog profile={editingContent} onClose={() => setEditingContent(null)} />}
      {removing && (
        <Dialog title={t("profiles.removeTitle")} onClose={() => setRemoving(null)} className="compact-dialog" hideClose>
          <h2>{t("profiles.removeQuestion", { name: removing.name })}</h2>
          <p>{t("profiles.removeWarning")}</p>
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              onClick={() => {
                const profile = removing;
                setRemoving(null);
                gate.ask({
                  profile,
                  title: t("profiles.removeNamed", { name: profile.name }),
                  description: t("profiles.removePinPrompt"),
                  action: async (pin) => {
                    await profiles.remove(profile.id, pin);
                    notify(t("profiles.removed", { name: profile.name }));
                  },
                });
              }}
            >
              {t("profiles.removeTitle")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
