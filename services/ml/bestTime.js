// Best time to publish: when does this author's audience actually read?
//
// Reading activity is binned into a 7×24 week grid in the author's own time
// zone, smoothed across neighbouring hours (people who read at 8pm also read
// at 7pm and 9pm) and the same hour on other days, then the peaks are returned.
// Publishing a little before a peak gives a post time to reach people.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * @param {Array<Date|number>} timestamps  when reads happened (UTC instants)
 * @param {object} opts
 * @param {number} opts.tzOffsetMinutes  as Date#getTimezoneOffset() in the browser (IST = -330)
 * @param {number} opts.leadHours        publish this long before the peak
 * @returns {{ grid:number[][], slots:{day:number,hour:number,label:string,score:number}[], sample:number }}
 */
function bestPublishTimes(timestamps, { tzOffsetMinutes = 0, leadHours = 1, top = 3 } = {}) {
  const raw = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let sample = 0;
  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) continue;
    const local = new Date(t - tzOffsetMinutes * 60000); // read with getUTC* = local time
    raw[local.getUTCDay()][local.getUTCHours()] += 1;
    sample++;
  }

  // Smooth: same hour ±1 (circular through midnight and the week), and a
  // little from the same hour on every other day.
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dayTotals = raw.map((row) => row.slice());
  const hourAcrossDays = new Array(24).fill(0);
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) hourAcrossDays[h] += raw[d][h] / 7;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const at = (dd, hh) => {
        const idx = (dd * 24 + hh + 168) % 168;
        return dayTotals[Math.floor(idx / 24)][idx % 24];
      };
      grid[d][h] = 0.5 * at(d, h) + 0.2 * at(d, h - 1) + 0.2 * at(d, h + 1) + 0.1 * hourAcrossDays[h];
    }
  }

  const max = Math.max(0, ...grid.flat());
  const normGrid = grid.map((row) => row.map((v) => (max ? Math.round((v / max) * 100) / 100 : 0)));

  // Peaks, at least 3 hours apart so the suggestions aren't 7pm, 8pm, 9pm.
  const cells = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push({ d, h, v: grid[d][h] });
  cells.sort((a, b) => b.v - a.v);
  const slots = [];
  for (const c of cells) {
    if (!c.v) break;
    const far = slots.every((s) => {
      const diff = Math.abs((c.d * 24 + c.h) - (s.peakDay * 24 + s.peakHour));
      return Math.min(diff, 168 - diff) >= 3;
    });
    if (!far) continue;
    const pubIdx = (c.d * 24 + c.h - leadHours + 168) % 168;
    const day = Math.floor(pubIdx / 24);
    const hour = pubIdx % 24;
    slots.push({
      day,
      hour,
      peakDay: c.d,
      peakHour: c.h,
      label: `${DAYS[day]} ${formatHour(hour)}`,
      score: max ? Math.round((c.v / max) * 100) / 100 : 0,
    });
    if (slots.length >= top) break;
  }

  return { grid: normGrid, slots, sample };
}

function formatHour(h) {
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${suffix}`;
}

module.exports = { bestPublishTimes, DAYS, formatHour };
