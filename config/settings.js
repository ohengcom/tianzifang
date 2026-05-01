import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const BASE_DIR = join(__dirname, '..');
export const DB_PATH = join(BASE_DIR, 'data', 'tianzifang.sqlite');

export const TIANZIFANG_LNG = 121.4625;
export const TIANZIFANG_LAT = 31.2070;

export const AMAP_API_KEY = process.env.AMAP_API_KEY || 'ab3a4e34653e5be7fce9f7f3aab7a6c2';
export const COLLECT_HOURS = [8, 12, 16, 20];

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36';
