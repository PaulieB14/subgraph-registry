"use client";

import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Bar,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "./Panel";
import { ClientOnly } from "./ClientOnly";

export interface DailyPoint {
  day: string;
  payments: number;
  ma7?: number;
}

function ma7(data: DailyPoint[]): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let i = 0; i < data.length; i++) {
    const window = data.slice(Math.max(0, i - 6), i + 1);
    const avg = window.reduce((s, x) => s + (x.payments || 0), 0) / window.length;
    out.push({ ...data[i], ma7: Math.round(avg) });
  }
  return out;
}

export function DailyChart({ data }: { data: DailyPoint[] }) {
  const series = ma7(data);
  return (
    <Panel title="Daily payments" caption="bars + 7-day MA">
      <div style={{ width: "100%", height: 224 }}>
        <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-md bg-panelHover/30" />}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 6, right: 4, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#2A2451" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="day"
              stroke="#5A5485"
              tick={{ fill: "#8D86B8", fontSize: 11 }}
              tickFormatter={(v) => String(v).slice(5)}
              minTickGap={28}
            />
            <YAxis stroke="#5A5485" tick={{ fill: "#8D86B8", fontSize: 11 }} width={36} />
            <Tooltip
              contentStyle={{
                background: "#15122E",
                border: "1px solid #2A2451",
                borderRadius: 8,
                color: "#E8E4FF",
                fontSize: 12,
              }}
              labelStyle={{ color: "#8D86B8" }}
            />
            <Bar dataKey="payments" fill="#6F4CFF" opacity={0.7} radius={[2, 2, 0, 0]}>
              {series.map((_, i) => (
                <Cell key={i} fill={i === series.length - 1 ? "#00FFB2" : "#6F4CFF"} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="ma7" stroke="#FFB547" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
        </ClientOnly>
      </div>
    </Panel>
  );
}
