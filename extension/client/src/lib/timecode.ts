const pad = (n: number) => String(n).padStart(2, "0");

/** Non-drop-frame HH:MM:SS:FF, as Premiere shows it for 23.976 / 25 / 30 fps. */
export function formatTimecode(seconds: number, fps: number): string {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  const frames = Math.min(Math.round(fps) - 1, Math.floor((s - whole) * fps));
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}:${pad(frames)}`;
}

/** m:ss.s — for durations and reclaimed time. */
export function formatDuration(seconds: number): string {
  const t = Math.round(Math.max(0, seconds) * 10) / 10;
  const m = Math.floor(t / 60);
  const r = (t - m * 60).toFixed(1);
  return `${m}:${r.padStart(4, "0")}`;
}
