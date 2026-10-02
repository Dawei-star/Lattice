import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BrandMark, COLORS, CornerBracket, Label, ProductWindow, SceneFrame, reveal } from "../components/Shared";

export const OpeningScene: React.FC = () => {
  const frame = useCurrentFrame();
  const logoScale = interpolate(frame, [0, 38], [0.72, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <SceneFrame index="01 / 05">
      <div style={{ position: "absolute", left: 110, top: 190, width: 650 }}>
        <div style={{ ...reveal(frame, 8), display: "flex", alignItems: "center", gap: 20 }}>
          <BrandMark size={86} glow style={{ scale: logoScale }} />
          <div>
            <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: -1 }}>Lattice</div>
            <div style={{ color: COLORS.muted, fontSize: 16, letterSpacing: 3, marginTop: 4 }}>LOCAL KNOWLEDGE, YOUR WAY</div>
          </div>
        </div>
        <div style={{ ...reveal(frame, 24, 52), marginTop: 70 }}>
          <Label>让思绪彼此连接</Label>
          <div style={{ fontSize: 64, lineHeight: 1.15, fontWeight: 700, letterSpacing: -2, marginTop: 24 }}>
            把知识，留在
            <br />
            <span style={{ color: COLORS.ice }}>自己的空间里。</span>
          </div>
          <div style={{ ...reveal(frame, 40, 22), fontSize: 21, color: COLORS.muted, lineHeight: 1.8, marginTop: 28 }}>
            本地优先的双链笔记知识库
            <br />
            Markdown · Canvas · AI
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", right: 72, top: 180, ...reveal(frame, 34, 60) }}>
        <ProductWindow src="assets/workspace-dark.png" width={860} height={590} scale={0.86} />
        <div
          style={{
            position: "absolute",
            top: 90,
            left: -78,
            width: 1080,
            height: 1,
            background: "linear-gradient(90deg, transparent, rgba(198,214,255,0.68), transparent)",
            rotate: "-12deg",
            opacity: 0.7,
          }}
        />
      </div>
      <div style={{ position: "absolute", left: 110, bottom: 88, width: 286, zIndex: 4, ...reveal(frame, 52, 18) }}>
        <CornerBracket color={COLORS.ice}>
          <div style={{ color: COLORS.ice, fontSize: 12, letterSpacing: 1.4 }}>AI KNOWLEDGE ASSISTANT</div>
          <div style={{ color: COLORS.white, fontSize: 18, marginTop: 10 }}>Ask your notes anything.</div>
          <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 8 }}>Grounded in your local vault</div>
        </CornerBracket>
      </div>
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          opacity: interpolate(frame, [0, 90], [0.2, 0.5], { extrapolateRight: "clamp" }),
          background: "linear-gradient(120deg, transparent 35%, rgba(111,134,240,0.12) 50%, transparent 63%)",
          translate: `${interpolate(frame, [0, 90], [-520, 420], { extrapolateRight: "clamp" })}px 0px`,
        }}
      />
    </SceneFrame>
  );
};
