export const DEFAULT_LABELS = [
  { name: "bug", color: "#eb5757" },
  { name: "功能优化", color: "#bb87fc" },
  { name: "任务", color: "#d99b25" },
  { name: "改进", color: "#4ea7fc" },
] as const;

export function labelColor(name: string): string {
  return DEFAULT_LABELS.find((label) => label.name === name)?.color ?? "#8b8d92";
}
