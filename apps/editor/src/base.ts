// A run opened from the list lives at /r/<key>/; its API is under the same prefix. Opened with --run it is at /.
export let apiBase = location.pathname.match(/^\/r\/[A-Za-z0-9_-]+/)?.[0] ?? '';
export const updateApiBase = (pathname = location.pathname) => {
  apiBase = pathname.match(/^\/r\/[A-Za-z0-9_-]+/)?.[0] ?? '';
};
