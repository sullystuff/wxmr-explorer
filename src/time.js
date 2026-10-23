export function relativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  const seconds = Math.floor(Math.abs(now - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  const [unit, size] = [
    ['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400],
    ['h', 3600], ['m', 60], ['s', 1],
  ].find(([, size]) => seconds >= size);
  const value = `${Math.floor(seconds / size)}${unit}`;
  return timestamp > now ? `in ${value}` : `${value} ago`;
}
