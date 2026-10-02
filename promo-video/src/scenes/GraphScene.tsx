import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { COLORS, Label, SceneFrame, reveal } from "../components/Shared";

const nodes = [
  { x: 340, y: 240, r: 16, label: "Project" },
  { x: 590, y: 160, r: 11, label: "Research" },
  { x: 760, y: 270, r: 21, label: "Ideas" },
  { x: 1010, y: 180, r: 13, label: "Reading" },
  { x: 1090, y: 410, r: 17, label: "Tasks" },
  { x: 810, y: 525, r: 12, label: "People" },
  { x: 520, y: 490, r: 18, label: "Journal" },
  { x: 300, y: 400, r: 10, label: "Notes" },
];

const edges = [
  [0, 1], [0, 2], [0, 6], [0, 7], [1, 2], [1, 3], [2, 3], [2, 4], [2, 5], [4, 5], [5, 6], [6, 7], [7, 0],
];

export const GraphScene: React.FC = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [8, 78], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const pulse = 0.82 + Math.sin(frame / 8) * 0.1;

  return (
    <SceneFrame index="03 / 05" eyebrow="LATTICE / CONNECT THE DOTS">
      <div style={{ position: "absolute", left: 110, top: 178, zIndex: 2, width: 430, ...reveal(frame, 4, 28) }}>
        <Label>Bidirectional links</Label>
        <div style={{ fontSize: 55, lineHeight: 1.18, fontWeight: 700, letterSpacing: -1.5, marginTop: 24 }}>
          让每条笔记，
          <br />
          <span style={{ color: COLORS.ice }}>找到它的关系。</span>
        </div>
        <p style={{ color: COLORS.muted, fontSize: 19, lineHeight: 1.8, marginTop: 28 }}>
          从孤立的想法，到一张
          <br />
          可以探索的知识网络。
        </p>
      </div>
      <svg width="1200" height="720" viewBox="0 0 1200 720" style={{ position: "absolute", left: 260, top: 120, overflow: "visible" }}>
        <g opacity={0.46}>
          {edges.map(([from, to], index) => {
            const a = nodes[from];
            const b = nodes[to];
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            return (
              <line
                key={`${from}-${to}`}
                x1={a.x}
                y1={a.y}
                x2={a.x + (b.x - a.x) * progress}
                y2={a.y + (b.y - a.y) * progress}
                stroke={index % 3 === 0 ? COLORS.ice : COLORS.cobalt}
                strokeWidth={index % 3 === 0 ? 2 : 1}
                strokeDasharray={`${length * 0.16} ${length * 0.08}`}
                strokeDashoffset={-frame * (index % 2 ? 0.8 : -0.55)}
              />
            );
          })}
        </g>
        {nodes.map((node, index) => {
          const scale = interpolate(frame, [10 + index * 4, 34 + index * 4], [0.15, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.elastic(1) });
          return (
            <g key={node.label} style={{ transformOrigin: `${node.x}px ${node.y}px`, transform: `scale(${scale})` }}>
              <circle cx={node.x} cy={node.y} r={node.r * 2.5} fill="none" stroke={COLORS.cobalt} strokeOpacity={0.16} strokeWidth={1} />
              <circle cx={node.x} cy={node.y} r={node.r * pulse} fill={index === 2 ? COLORS.ice : COLORS.blue} fillOpacity={index === 2 ? 1 : 0.88} />
              <circle cx={node.x - node.r * 0.3} cy={node.y - node.r * 0.3} r={node.r * 0.28} fill="#ffffff" fillOpacity={0.72} />
              <text x={node.x + node.r + 14} y={node.y + 5} fill={COLORS.muted} fontSize="16" fontFamily="Microsoft YaHei, Segoe UI, sans-serif">{node.label}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ position: "absolute", right: 110, bottom: 116, ...reveal(frame, 56, 18) }}>
        <div style={{ fontSize: 14, color: COLORS.muted, letterSpacing: 2 }}>LINKED BY CONTEXT</div>
        <div style={{ width: 184, height: 1, marginTop: 13, background: `linear-gradient(90deg, ${COLORS.ice}, transparent)` }} />
      </div>
      <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.14, background: "linear-gradient(125deg, transparent 30%, rgba(198,214,255,0.18) 50%, transparent 70%)", translate: `${interpolate(frame, [0, 110], [-600, 700], { extrapolateRight: "clamp" })}px 0px` }} />
    </SceneFrame>
  );
};
