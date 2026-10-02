import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, CornerBracket, Label, Pill, ProductWindow, SceneFrame, reveal } from "../components/Shared";

export const LocalFirstScene: React.FC = () => {
  const frame = useCurrentFrame();
  const shieldProgress = interpolate(frame, [14, 62], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <SceneFrame index="02 / 05" eyebrow="LATTICE / LOCAL FIRST">
      <div style={{ position: "absolute", left: 110, top: 205, width: 560 }}>
        <div style={reveal(frame, 6)}>
          <Label>Local-first by design</Label>
          <div style={{ fontSize: 56, lineHeight: 1.18, fontWeight: 700, letterSpacing: -1.5, marginTop: 24 }}>
            你的数据，始终在
            <br />
            <span style={{ color: COLORS.ice }}>你的设备上。</span>
          </div>
          <p style={{ color: COLORS.muted, fontSize: 20, lineHeight: 1.8, marginTop: 28, marginBottom: 0 }}>
            不需要注册，不依赖联网。
            <br />
            Markdown 文件，就是你的知识库。
          </p>
        </div>
        <div style={{ ...reveal(frame, 34, 18), display: "flex", gap: 12, marginTop: 42, flexWrap: "wrap" }}>
          <Pill>Offline-first</Pill>
          <Pill>Plain text</Pill>
          <Pill>Data sovereignty</Pill>
        </div>
      </div>
      <div style={{ position: "absolute", right: 96, top: 180, ...reveal(frame, 18, 48) }}>
        <ProductWindow src="assets/workspace-dark.png" width={780} height={530} scale={0.88} />
        <div
          style={{
            position: "absolute",
            inset: -30,
            border: "1px solid rgba(111,134,240,0.3)",
            borderRadius: 34,
            clipPath: `inset(${(1 - shieldProgress) * 45}% 0 0 0 round 34px)`,
            boxShadow: "0 0 50px rgba(59,80,223,0.18), inset 0 0 50px rgba(111,134,240,0.08)",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: -26,
            top: 76,
            width: 196,
            ...reveal(frame, 52, 18),
          }}
        >
          <CornerBracket>
            <div style={{ color: COLORS.ice, fontSize: 14, letterSpacing: 1.5 }}>PRIVATE VAULT</div>
            <div style={{ color: COLORS.white, fontSize: 18, marginTop: 12 }}>Everything stays local.</div>
          </CornerBracket>
        </div>
      </div>
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          opacity: 0.34,
          background: "linear-gradient(90deg, transparent 0%, rgba(111,134,240,0.08) 50%, transparent 100%)",
          translate: `${interpolate(frame, [0, 100], [-640, 640], { extrapolateRight: "clamp" })}px 0px`,
        }}
      />
    </SceneFrame>
  );
};

