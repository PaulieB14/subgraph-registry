"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Panel } from "./Panel";

export interface NRPoint {
  week: string;
  new_agents: number;
  returning_agents: number;
}

export function NewVsReturning({ data }: { data: NRPoint[] }) {
  if (!data || data.length === 0) {
    return (
      <Panel title="New vs returning agents" caption="weekly">
        <div className="py-12 text-center text-sm text-dim">Building cohort…</div>
      </Panel>
    );
  }
  return (
    <Panel title="New vs returning agents" caption="weekly">
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 4, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#2A2451" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="week"
              stroke="#5A5485"
              tick={{ fill: "#8D86B8", fontSize: 11 }}
              tickFormatter={(v) => String(v).slice(5)}
            />
            <YAxis stroke="#5A5485" tick={{ fill: "#8D86B8", fontSize: 11 }} width={32} />
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
            <Legend
              iconType="circle"
              wrapperStyle={{ paddingTop: 6, fontSize: 11, color: "#8D86B8" }}
            />
            <Bar dataKey="new_agents" name="first-time" stackId="a" fill="#00FFB2" radius={[2, 2, 0, 0]} />
            <Bar dataKey="returning_agents" name="returning" stackId="a" fill="#6F4CFF" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
