// A run opened from the list lives at /r/<key>/; its API is under the same prefix. Opened with --run it is at /.
export const apiBase = location.pathname.match(/^\/r\/[A-Za-z0-9_-]+/)?.[0] ?? '';
