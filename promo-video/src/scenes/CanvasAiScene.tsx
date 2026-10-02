import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { COLORS, CornerBracket, Label, ProductWindow, SceneFrame, reveal } from "../components/Shared";

export const CanvasAiScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <SceneFrame index="04 / 05" eyebrow="LATTICE / THINK IN CONTEXT">
      <div style={{ position: "absolute", left: 110, top: 180, width: 470, zIndex: 2, ...reveal(frame, 5, 28) }}>
        <Label>Canvas + AI assistant</Label>
        <div style={{ fontSize: 53, lineHeight: 1.18, fontWeight: 700, letterSpacing: -1.5, marginTop: 24 }}>
          从一张白板，
          <br />
          <span style={{ color: COLORS.ice }}>走到答案。</span>
        </div>
        <p style={{ color: COLORS.muted, fontSize: 19, lineHeight: 1.8, marginTop: 28 }}>
          把笔记、关系和 AI 放在同一个上下文里。
        </p>
      </div>
      <div style={{ position: "absolute", right: 72, top: 162, width: 920, height: 610, ...reveal(frame, 20, 50) }}>
        <div style={{ position: "absolute", left: 0, top: 34, width: 560, zIndex: 2, rotate: "-2deg" }}>
          <ProductWindow src="assets/canvas.png" width={730} height={490} scale={0.82} />
        </div>
        <div style={{ position: "absolute", left: 300, top: 82, width: 560, zIndex: 3, rotate: "3deg" }}>
          <ProductWindow src="assets/ai-assistant.png" width={730} height={490} scale={0.82} />
        </div>
        <div style={{ position: "absolute", top: 340, left: 120, width: 610, height: 1, background: `linear-gradient(90deg, transparent, ${COLORS.ice}, transparent)`, opacity: 0.76, translate: `${interpolate(frame, [0, 100], [-160, 160], { extrapolateRight: "clamp" })}px 0px` }} />
        <div style={{ position: "absolute", right: 8, top: -6, width: 255, zIndex: 5, ...reveal(frame, 48, 18) }}>
          <CornerBracket color={COLORS.ice}>
            <div style={{ color: COLORS.ice, fontSize: 12, letterSpacing: 1.5 }}>AI KNOWLEDGE ASSISTANT</div>
            <div style={{ color: COLORS.white, fontSize: 20, marginTop: 12 }}>Ask your vault.</div>
            <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 12 }}>Retrieving context from 3 linked notes...</div>
            <div style={{ height: 2, width: `${interpolate(frame, [50, 86], [12, 168], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px`, backgroundColor: COLORS.ice, marginTop: 16 }} />
            <div style={{ color: COLORS.cobalt, fontSize: 12, marginTop: 10 }}>CITED · GROUNDED · LOCAL</div>
          </CornerBracket>
        </div>
      </div>
      <div style={{ position: "absolute", left: 116, bottom: 112, display: "flex", gap: 28, ...reveal(frame, 56, 16) }}>
        {["Local notes", "Context retrieval", "Grounded answer"].map((item, index) => (
          <div key={item} style={{ display: "flex", alignItems: "center", gap: 10, color: index === 2 ? COLORS.ice : COLORS.muted, fontSize: 15 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, backgroundColor: index === 2 ? COLORS.ice : COLORS.cobalt }} />
            {item}
          </div>
        ))}
      </div>
    </SceneFrame>
  );
};
