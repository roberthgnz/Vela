import { useCallback, type ReactNode } from "react";
import { AlertCircle, ArrowUpRight, Film, LoaderCircle, X } from "lucide-react";
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
  return (
    <div className={`artwork ${className}`}>
      <span className="artwork-fallback" aria-hidden="true">
        <Film size={28} />
        <span>{name}</span>
      </span>
      {safeImage(src) && (
        <img
          src={safeImage(src)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
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
      aria-label={title}
      className={`dialog ${className}`}
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <button
        className="icon-button dialog-close"
        aria-label="Cerrar"
        onClick={onClose}
      >
        <X size={19} />
      </button>
      {children}
    </dialog>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <Film size={26} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          Reintentar <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  );
}

export function Loading({ label = "Cargando" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={19} />
      <span>{label}</span>
    </div>
  );
}
