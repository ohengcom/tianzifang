const TIMEZONE = 'Asia/Shanghai';

export function toShanghaiDate(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
}

export function toShanghaiDateString(date = new Date()) {
  return toShanghaiDate(date).toLocaleDateString('sv-SE');
}

export function toShanghaiDateTimeString(date = new Date()) {
  return toShanghaiDate(date).toLocaleString('sv-SE').replace(' ', 'T');
}

export function toShanghaiIsoString(date = new Date()) {
  return `${toShanghaiDateTimeString(date)}+08:00`;
}

export function toShanghaiLogTimestamp(date = new Date()) {
  return toShanghaiDate(date).toLocaleString('sv-SE', {
    timeZone: TIMEZONE,
  });
}

export function dayWithOffsetDays(offsetDays = 0) {
  const now = toShanghaiDate();
  now.setDate(now.getDate() + offsetDays);
  return now;
}

export function shanghaiDate(offsetDays = 0) {
  return toShanghaiDateString(dayWithOffsetDays(offsetDays));
}

export function weekdayFromShanghaiDate(yyyyMmDd) {
  const date = new Date(`${yyyyMmDd}T12:00:00+08:00`);
  const weekday = date.getDay();
  return weekday === 0 ? 6 : weekday - 1;
}
