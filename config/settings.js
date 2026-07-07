export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36';

function normalizeNeonUrl(url) {
  if (!url) return url;
  const parsed = new URL(url);
  const sslMode = parsed.searchParams.get('sslmode');
  if (!sslMode) {
    parsed.searchParams.set('sslmode', 'verify-full');
  } else if (['prefer', 'require', 'verify-ca'].includes(sslMode)) {
    parsed.searchParams.set('sslmode', 'verify-full');
  }
  return parsed.toString();
}

export const NEON_URL = normalizeNeonUrl(process.env.NEON_URL);
