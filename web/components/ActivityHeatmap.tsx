import { Panel } from "./Panel";

export interface HeatPoint {
  hour: number;
  day_of_week: number;
  count: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityHeatmap({ data }: { data: HeatPoint[] }) {
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 1;
  for (const p of data) {
    const d = p.day_of_week ?? 0;
    const h = p.hour ?? 0;
    if (d >= 0 && d < 7 && h >= 0 && h < 24) {
      matrix[d][h] = p.count;
      if (p.count > max) max = p.count;
    }
  }

  return (
    <Panel title="Activity heatmap" caption="hour × day of week (UTC)">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px] text-[10px] text-dim">
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="font-mono font-normal">
                  {h % 4 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((label, dow) => (
              <tr key={dow}>
                <td className="pr-2 text-right font-medium">{label}</td>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = matrix[dow][h];
                  const t = v / max;
                  const bg = t === 0
                    ? "rgba(111,76,255,0.06)"
                    : `rgba(111,76,255,${0.18 + t * 0.82})`;
                  return (
                    <td
                      key={h}
                      title={`${label} ${h.toString().padStart(2, "0")}:00 — ${v} payments`}
                      className="rounded-sm"
                      style={{ background: bg, width: 14, height: 14 }}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
