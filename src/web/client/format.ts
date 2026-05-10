export function formatEventType(type: string): string {
  return type.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
