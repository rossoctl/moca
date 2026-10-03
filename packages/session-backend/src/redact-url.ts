/**
 * A URL safe to print: any userinfo (`user:password@`, `:password@`, `user@`) becomes `***@`.
 * Anything that does not parse as a URL is returned unchanged -- this guards log lines, it does not
 * validate input. Exists because deploy/k8s puts the Redis password in REDIS_URL (node-redis reads
 * credentials only from the URL), and error messages used to interpolate the whole URL.
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.username === '' && u.password === '') return raw;
  u.username = '';
  u.password = '';
  return u.toString().replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, '$1***@');
}
