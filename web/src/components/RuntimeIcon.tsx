import codexLogo from "@lobehub/icons-static-svg/icons/codex-color.svg";
import claudeCodeLogo from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import type { TaskRuntime } from "../types";

export const RUNTIME_LABELS: Record<TaskRuntime, string> = {
  codex: "Codex",
  claude: "Claude Code",
  omp: "Oh My Pi",
};

export function RuntimeIcon({
  runtime,
  className,
  title = RUNTIME_LABELS[runtime],
}: {
  runtime: TaskRuntime;
  className?: string;
  title?: string;
}) {
  if (runtime === "omp") {
    return (
      <span className={className ? `${className} runtime-icon runtime-icon-omp` : "runtime-icon runtime-icon-omp"} title={title} aria-label={title}>
        π
      </span>
    );
  }

  return (
    <img
      className={className ? `${className} runtime-icon` : "runtime-icon"}
      src={runtime === "claude" ? claudeCodeLogo : codexLogo}
      alt={title}
      title={title}
    />
  );
}
