import { useState, useSyncExternalStore } from "react";
import { Check, Plus } from "lucide-react";
import type { MediaItem } from "../lib/contracts";
import { t } from "../lib/i18n";
import { MAX_COLLECTIONS, mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { Dialog } from "./Primitives";

type PickerRequest = { meta: MediaItem; addonUrl?: string; onSave?: () => void };
let request: PickerRequest | null = null;
const listeners = new Set<() => void>();
const setRequest = (value: PickerRequest | null) => {
  request = value;
  for (const listener of [...listeners]) listener();
};

/**
 * Opens the collection picker for a title. It lives in `CollectionPickerHost`, not in the card that
 * asked: in a collection's tab, taking the title out removes its card and must not close the picker.
 */
export function openCollectionPicker(value: PickerRequest) {
  setRequest(value);
}

export function CollectionPickerHost() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request,
  );
  return current ? <CollectionPicker {...current} onClose={() => setRequest(null)} /> : null;
}

/** The message for an error thrown by the store's collection methods. */
export function collectionError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "duplicate") return t("collections.errorDuplicate");
  if (code === "limit") return t("collections.errorLimit", { count: MAX_COLLECTIONS });
  return t("collections.errorEmpty");
}

/** A name for a new collection, or a new name for one. */
export function CollectionNameDialog({
  title,
  initial = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  submitLabel: string;
  /** Throws the store's errors, shown under the field. */
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  return (
    <Dialog title={title} onClose={onClose} className="compact-dialog" hideClose>
      <h2>{title}</h2>
      <form
        className="collection-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onSubmit(name);
            onClose();
          } catch (cause) {
            setError(collectionError(cause));
          }
        }}
      >
        <input
          className="input"
          data-autofocus
          aria-label={t("collections.namePlaceholder")}
          placeholder={t("collections.namePlaceholder")}
          maxLength={40}
          value={name}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="button primary" disabled={!name.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Puts a title in the library's collections (or takes it out), and creates collections on the way.
 * A title not in the library is saved first: with `onSave` (the card's own save) or with `addonUrl`.
 */
export function CollectionPicker({
  meta,
  addonUrl = "",
  onSave,
  onClose,
}: {
  meta: MediaItem;
  addonUrl?: string;
  onSave?: () => void;
  onClose: () => void;
}) {
  const { collections, library } = usePreferences();
  const key = mediaKey(meta.type, meta.id);
  const ensureSaved = () => {
    if (!library[key]?.saved) onSave?.();
  };
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const create = () => {
    try {
      const id = preferencesStore.createCollection(name);
      ensureSaved();
      preferencesStore.setInCollection(id, meta, addonUrl, true);
      setName("");
    } catch (cause) {
      setError(collectionError(cause));
    }
  };
  const title = t("collections.dialogTitle", { name: meta.name });
  return (
    <Dialog title={title} onClose={onClose} className="compact-dialog collection-picker" hideClose>
      <h2>{title}</h2>
      <p>{t("collections.dialogHint")}</p>
      {collections.length ? (
        <ul className="collection-options" aria-label={t("collections.tabs")}>
          {collections.map((collection) => {
            const included = collection.keys.includes(key);
            return (
              <li key={collection.id}>
                <button
                  role="checkbox"
                  aria-checked={included}
                  className="collection-option"
                  onClick={() => {
                    if (!included) ensureSaved();
                    preferencesStore.setInCollection(collection.id, meta, addonUrl, !included);
                  }}
                >
                  <span className="collection-check" aria-hidden="true">
                    {included && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="collection-name">{collection.name}</span>
                  <span className="tab-count">{collection.keys.length}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="collection-none">{t("collections.none")}</p>
      )}
      <form
        className="collection-new"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <input
          className="input"
          aria-label={t("collections.new")}
          placeholder={t("collections.new")}
          maxLength={40}
          value={name}
          aria-invalid={Boolean(error)}
          {...(collections.length ? {} : { "data-autofocus": true })}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
        <button className="button secondary" disabled={!name.trim()}>
          <Plus size={14} /> {t("collections.create")}
        </button>
      </form>
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="form-actions">
        <button className="button primary" {...(collections.length ? { "data-autofocus": true } : {})} onClick={onClose}>
          {t("collections.done")}
        </button>
      </div>
    </Dialog>
  );
}
