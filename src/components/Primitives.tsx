import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, Film, LoaderCircle, RotateCw, X } from "lucide-react";
import { safeImage } from "../lib/utils";

export function Artwork({
  src,
  name,
  className = "",
}: {
  src?: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = safeImage(src);
  return (
    <div className={`artwork ${className}`}>
      {(!url || failed) && (
        <span className="artwork-fallback" aria-hidden="true">
          <Film size={20} strokeWidth={1.5} />
          <span>{name}</span>
        </span>
      )}
      {url && !failed && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

export function Dialog({
  title,
  children,
  onClose,
  className = "",
  hideClose,
  labelledBy,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  hideClose?: boolean;
  labelledBy?: string;
}) {
  const mount = useCallback((node: HTMLDialogElement | null) => {
    if (!node) return;
    node.showModal();
    node.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (node.open) node.close();
    };
  }, []);
  return (
    <dialog
      ref={mount}
      aria-label={labelledBy ? undefined : title}
      aria-labelledby={labelledBy}
      className={`dialog ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      {!hideClose && (
        <button
          className="icon-button dialog-close"
          aria-label="Cerrar"
          title="Cerrar (Esc)"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      )}
      {children}
    </dialog>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <div className="empty-icon">{icon || <Film size={20} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  retry,
  title,
}: {
  message: string;
  retry?: () => void;
  title?: string;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={16} />
      <div>
        {title && <strong>{title}</strong>}
        <span>{message}</span>
      </div>
      {retry && (
        <button className="button small subtle" onClick={retry}>
          <RotateCw size={13} /> Reintentar
        </button>
      )}
    </div>
  );
}

export function Loading({ label = "Cargando" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={16} />
      <span>{label}</span>
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-hidden="true" />;
}

export function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      className={`switch ${checked ? "checked" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          aria-label={option.title}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const index = options.findIndex((item) => item.value === value);
            const step =
              event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = options[(index + step + options.length) % options.length];
            onChange(next.value);
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll("button");
            buttons?.[options.indexOf(next)]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect: () => void;
    }
  | "separator";

export type MenuAnchor = { x: number; y: number; align?: "start" | "end"; above?: boolean };

export function anchorFrom(element: Element, align: "start" | "end" = "start", above = false): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return {
    x: align === "end" ? rect.right : rect.left,
    y: above ? rect.top - 6 : rect.bottom + 4,
    align,
    above,
  };
}

/** Lightweight menu rendered in the top layer through the Popover API. */
export function Menu({
  anchor,
  items,
  label,
  onClose,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<Element | null>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    previous.current = document.activeElement;
    node.showPopover();
    const rect = node.getBoundingClientRect();
    let left = anchor.align === "end" ? anchor.x - rect.width : anchor.x;
    let top = anchor.above ? anchor.y - rect.height : anchor.y;
    left = Math.max(8, Math.min(left, innerWidth - rect.width - 8));
    if (top + rect.height > innerHeight - 8) top = Math.max(8, anchor.y - rect.height - 8);
    setPosition({ left, top: Math.max(8, top) });
    node.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)")?.focus();
    return () => {
      if (node.matches(":popover-open")) node.hidePopover();
    };
  }, [anchor]);
  const close = (restore = true) => {
    onClose();
    if (restore && previous.current instanceof HTMLElement && previous.current.isConnected)
      previous.current.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)"),
    ];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      entries[event.key === "Home" ? 0 : entries.length - 1]?.focus();
    }
  };
  return (
    <div
      ref={ref}
      popover="auto"
      role="menu"
      aria-label={label}
      className="menu"
      style={position}
      onKeyDown={onKeyDown}
      onToggle={(event) => {
        if ((event as unknown as ToggleEvent).newState === "closed") onClose();
      }}
    >
      {items.map((item, index) =>
        item === "separator" ? (
          <div className="menu-separator" role="separator" key={`s${index}`} />
        ) : (
          <button
            key={item.label}
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            className={`menu-item ${item.danger ? "danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            <span className="menu-icon">{item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[]; label: string } | null>(null);
  const element = menu ? (
    <Menu
      anchor={menu.anchor}
      items={menu.items}
      label={menu.label}
      onClose={() => setMenu(null)}
    />
  ) : null;
  return {
    open: (anchor: MenuAnchor, items: MenuItem[], label: string) =>
      setMenu({ anchor, items, label }),
    close: () => setMenu(null),
    isOpen: Boolean(menu),
    element,
  };
}
