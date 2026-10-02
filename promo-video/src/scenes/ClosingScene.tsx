import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { BrandMark, COLORS, Label, Pill, SceneFrame, reveal } from "../components/Shared";

export const ClosingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const markScale = interpolate(frame, [6, 44], [0.75, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const lineWidth = interpolate(frame, [24, 64], [0, 440], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });

  return (
    <SceneFrame index="05 / 05" eyebrow="LATTICE / YOUR KNOWLEDGE, YOURS">
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div style={{ ...reveal(frame, 4, 22), display: "flex", flexDirection: "column", alignItems: "center" }}>
          <BrandMark size={132} glow style={{ scale: markScale }} />
          <div style={{ fontSize: 68, fontWeight: 700, letterSpacing: -2, marginTop: 24 }}>Lattice</div>
          <Label color={COLORS.ice}>AI-powered local knowledge</Label>
          <div style={{ fontSize: 30, lineHeight: 1.5, color: COLORS.ice, marginTop: 34 }}>把知识交还给自己。</div>
          <div style={{ color: COLORS.muted, fontSize: 17, letterSpacing: 0.6, marginTop: 10 }}>An AI assistant grounded in your own notes.</div>
          <div style={{ width: lineWidth, height: 1, background: `linear-gradient(90deg, transparent, ${COLORS.ice}, transparent)`, marginTop: 34 }} />
          <div style={{ display: "flex", gap: 12, marginTop: 28, ...reveal(frame, 46, 14) }}>
            <Pill>Local notes</Pill>
            <Pill>Linked context</Pill>
            <Pill>AI assistant</Pill>
          </div>
          <div style={{ ...reveal(frame, 60, 12), color: COLORS.muted, fontSize: 15, letterSpacing: 1.4, marginTop: 36 }}>github.com/Dawei-star/Lattice</div>
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 220, background: "linear-gradient(to top, rgba(59,80,223,0.16), transparent)", opacity: interpolate(frame, [0, 45], [0, 1], { extrapolateRight: "clamp" }) }} />
    </SceneFrame>
  );
};
