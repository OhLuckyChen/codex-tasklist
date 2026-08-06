import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TASK_STATUSES, type TaskStatus } from "../types";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LinearIcon } from "./LinearIcon";

interface BoardSettingsMenuProps {
  visibleStatuses: readonly TaskStatus[];
  applyToAllProjects: boolean;
  onStatusVisibilityChange: (status: TaskStatus, visible: boolean) => void;
  onApplyToAllProjectsChange: (enabled: boolean) => void;
}

export function BoardSettingsMenu({
  visibleStatuses,
  applyToAllProjects,
  onStatusVisibilityChange,
  onApplyToAllProjectsChange,
}: BoardSettingsMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[role='checkbox']")?.focus());

    function closeFromOutside(event: PointerEvent) {
      if (
        !menuRef.current?.contains(event.target as Node)
        && !triggerRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function closeFromViewportChange() {
      setOpen(false);
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("blur", closeFromViewportChange);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("blur", closeFromViewportChange);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="board-settings-menu"
      role="dialog"
      aria-label="看板设置"
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          const switches = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
            "[role='checkbox'], [role='switch']",
          ) ?? [])]
            .filter((button) => !button.disabled);
          const currentIndex = switches.indexOf(document.activeElement as HTMLButtonElement);
          const offset = event.shiftKey ? -1 : 1;
          switches[(currentIndex + offset + switches.length) % switches.length]?.focus();
        }
      }}
    >
      <section className="board-settings-section" aria-labelledby="board-options-heading">
        <h2 id="board-options-heading">展示状态列</h2>
        <p className="board-setting-description">已勾选的列即使没有议题也会保留。</p>
        <div className="board-status-options">
          {TASK_STATUSES.map((status) => {
            const visible = visibleStatuses.includes(status);
            const details = STATUS_DETAILS[status];
            return (
              <button
                type="button"
                className={`board-status-option${visible ? " is-checked" : ""}`}
                role="checkbox"
                aria-checked={visible}
                key={status}
                onClick={() => onStatusVisibilityChange(status, !visible)}
              >
                <span className={`status-icon status-icon-${details.tone}`} aria-hidden="true">
                  <StatusIcon status={status} />
                </span>
                <span>{details.label}</span>
                <span className="board-status-check" aria-hidden="true">
                  {visible && <LinearIcon name="check" />}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="board-settings-section" aria-labelledby="global-column-visibility-label">
        <div className="board-setting-row">
          <span className="board-setting-copy">
            <span id="global-column-visibility-label">应用到所有项目</span>
            <small>开启后，所有项目使用同一套状态列。</small>
          </span>
          <button
            type="button"
            className={`board-setting-switch${applyToAllProjects ? " is-on" : ""}`}
            role="switch"
            aria-checked={applyToAllProjects}
            aria-labelledby="global-column-visibility-label"
            onClick={() => onApplyToAllProjectsChange(!applyToAllProjects)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`board-settings-trigger${open ? " is-open" : ""}`}
        aria-label="看板设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="看板设置"
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name="displayOptions" />
      </button>
      {menu}
    </>
  );
}
