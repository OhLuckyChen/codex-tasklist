import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TASK_STATUSES, type TaskStatus } from "../types";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";

interface UnreadStatusMenuProps {
  statuses: Set<TaskStatus>;
  unreadCount: number;
  onChange: (statuses: Set<TaskStatus>) => void;
}

export function UnreadStatusMenu({ statuses, unreadCount, onChange }: UnreadStatusMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });

  function toggleStatus(status: TaskStatus) {
    const next = new Set(statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange(next);
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(triggerRect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
    const below = triggerRect.bottom + 6;
    const top = below + menuRect.height <= window.innerHeight - 8
      ? below
      : Math.max(8, triggerRect.top - menuRect.height - 6);
    setPosition({ left, top, ready: true });
  }, [open, statuses]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("blur", closeFromViewportChange);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("blur", closeFromViewportChange);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const summary = statuses.size === 0
    ? "未启用"
    : statuses.size === 1
      ? STATUS_DETAILS[[...statuses][0]].label
      : `${statuses.size} 个状态`;

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="unread-status-menu"
      role="menu"
      aria-label="未读红点状态"
      style={{
        left: position.left,
        top: position.top,
        opacity: position.ready ? 1 : 0,
      }}
    >
      <div className="unread-status-menu-heading">
        <span>未读红点</span>
        <small>{summary}</small>
      </div>
      <div className="unread-status-options">
        {TASK_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            role="menuitemcheckbox"
            aria-checked={statuses.has(status)}
            className={`unread-status-option${statuses.has(status) ? " is-selected" : ""}`}
            onClick={() => toggleStatus(status)}
          >
            <span className={`filter-status-icon status-${status}`}><LinearStatusIcon status={status} /></span>
            <span>{STATUS_DETAILS[status].label}</span>
            <span className="unread-status-check">{statuses.has(status) && <LinearIcon name="check" />}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        className={`unread-status-trigger${statuses.size > 0 ? " is-active" : ""}${open ? " is-open" : ""}`}
        type="button"
        aria-label="设置未读红点状态"
        aria-haspopup="menu"
        aria-expanded={open}
        title="未读红点"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="unread-trigger-dot" aria-hidden="true" />
        <span>未读</span>
        {unreadCount > 0 && <span className="unread-trigger-count">{unreadCount}</span>}
      </button>
      {menu}
    </>
  );
}
