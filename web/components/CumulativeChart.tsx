"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Panel } from "./Panel";
import { ClientOnly } from "./ClientOnly";

export interface CumulativePoint {
  day: string;
  cumulative_usdc: number;
  cumulative_payments?: number;
}

export function CumulativeChart({ data }: { data: CumulativePoint[] }) {
  return (
    <Panel title="Cumulative USDC paid" caption={`${data.length} days`}>
      <div style={{ width: "100%", height: 224 }}>
        <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded-md bg-panelHover/30" />}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 4, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="gradUSDC" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6F4CFF" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#6F4CFF" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#2A2451" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="day"
              stroke="#5A5485"
              tick={{ fill: "#8D86B8", fontSize: 11 }}
              tickFormatter={(v) => String(v).slice(5)}
              minTickGap={28}
            />
            <YAxis
              stroke="#5A5485"
              tick={{ fill: "#8D86B8", fontSize: 11 }}
              tickFormatter={(v) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`)}
              width={48}
            />
            <Tooltip
              contentStyle={{
                background: "#15122E",
                border: "1px solid #2A2451",
                borderRadius: 8,
                color: "#E8E4FF",
                fontSize: 12,
              }}
              labelStyle={{ color: "#8D86B8" }}
              formatter={(v: unknown) => [`$${Number(v).toLocaleString()}`, "USDC"]}
            />
            <Area
              type="monotone"
              dataKey="cumulative_usdc"
              stroke="#6F4CFF"
              strokeWidth={2}
              fill="url(#gradUSDC)"
            />
          </AreaChart>
        </ResponsiveContainer>
        </ClientOnly>
      </div>
    </Panel>
  );
}
